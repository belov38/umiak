// Service tokens of the internal listener (S7 §7.8, S2 §5.5): the file
// SBX_API_SERVICE_TOKENS_FILE maps each caller to the tokens it may use
// (`{"gateway": ["<t1>", "<t2>"]}`, two at a time for rotation). Tokens are
// compared as sha256 digests with timingSafeEqual, against every entry.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";

const FileSchema = z.record(
	z.string().min(1),
	z.array(z.string().min(1, "a token must not be empty")),
);

function digest(token: string): Buffer {
	return createHash("sha256").update(token).digest();
}

export class ServiceTokens {
	readonly #entries: { caller: string; digest: Buffer }[];

	/** `tokens`: caller name -> accepted tokens. */
	constructor(tokens: Record<string, readonly string[]>) {
		this.#entries = Object.entries(tokens).flatMap(([caller, list]) =>
			list.map((t) => ({ caller, digest: digest(t) })),
		);
	}

	/** The caller of a token, or null. Constant time per entry. */
	verify(token: string): string | null {
		if (token === "") return null;
		const d = digest(token);
		let caller: string | null = null;
		for (const e of this.#entries) {
			if (timingSafeEqual(d, e.digest) && caller === null) caller = e.caller;
		}
		return caller;
	}
}

/** Reads SBX_API_SERVICE_TOKENS_FILE; a missing or malformed file throws. */
export function loadServiceTokens(file: string): ServiceTokens {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new Error(
			`service tokens file ${file}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	const r = FileSchema.safeParse(raw);
	if (!r.success) {
		const why = r.error.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ");
		throw new Error(
			`service tokens file ${file} must be {"<caller>": ["<token>", ...]}: ${why}`,
		);
	}
	return new ServiceTokens(r.data);
}

/** Every request of the internal listener needs a service token. */
export function serviceAuth(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(
			c.req.header("authorization") ?? "",
		);
		const caller =
			m === null ? null : deps.serviceTokens.verify(m[1] as string);
		if (caller === null) {
			deps.metrics.authFailures.inc({ reason: "service_token" });
			throw new ApiError(
				401,
				"unauthorized",
				"a valid service token is required",
			);
		}
		c.set("serviceCaller", caller);
		await next();
	};
}
