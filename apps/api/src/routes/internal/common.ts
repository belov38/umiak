// Shared pieces of the internal listener endpoints.
import type { Context, MiddlewareHandler } from "hono";
import type pg from "pg";
import type { z } from "zod";
import type { ApiDeps, ApiEnv } from "../../deps.ts";
import {
	ApiError,
	invalidJsonError,
	validationError,
	zodValidationError,
} from "../../http/errors.ts";

/** Caller name of the gateway's tokens in SBX_API_SERVICE_TOKENS_FILE. */
export const GATEWAY_CALLER = "gateway";

/** The gateway endpoints answer the gateway only (other service tokens: 403). */
export function requireGateway(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (c.var.serviceCaller !== GATEWAY_CALLER) {
			throw new ApiError(
				403,
				"forbidden",
				"this endpoint is for the gateway's service token",
			);
		}
		await next();
	};
}

/** The pool of the internal endpoints; every deployment has one. */
export function poolOf(deps: ApiDeps): pg.Pool {
	if (deps.pool === null) {
		throw new Error("internal endpoints need Postgres (deps.pool is null)");
	}
	return deps.pool;
}

/**
 * A JSON body checked by `schema`. Unknown fields are accepted (the schemas
 * are not strict): the gateway may send fields added after this api.
 */
export async function readJson<T extends z.ZodType>(
	c: Context<ApiEnv>,
	schema: T,
): Promise<z.output<T>> {
	const type = c.req.header("content-type")?.toLowerCase() ?? "";
	if (!/^application\/json\b/.test(type)) {
		throw validationError([
			{ path: "header.content-type", message: "must be application/json" },
		]);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(await c.req.text());
	} catch {
		throw invalidJsonError();
	}
	const r = schema.safeParse(raw);
	if (!r.success) throw zodValidationError("json", r.error);
	return r.data;
}
