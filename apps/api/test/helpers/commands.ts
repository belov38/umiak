// Helpers of the command tests: a ready sandbox on the FakeAgent, an NDJSON
// stream read line by line while it is open (frames validated against the
// document), and folding frames into the bytes of each stream.
import { createHash } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import type { Frame } from "../../src/index.ts";
import { assertConforms } from "./conformance.ts";
import { type Harness, OPENAPI_DOC, validatedOperations } from "./harness.ts";
import type { ApiWorld } from "./world.ts";

// biome-ignore lint/suspicious/noExplicitAny: frames and bodies are checked by the conformance harness
export type Any = any;

export interface ReadySandbox {
	sandboxId: string;
	machineId: string;
	slug: string;
	/** `sb_...` */
	ref: string;
	/** `/v1/sandboxes/sb_.../commands` */
	commands: string;
}

export async function readySandbox(
	w: ApiWorld,
	teamId?: string,
): Promise<ReadySandbox> {
	const s = await w.seed({
		state: "ready",
		...(teamId === undefined ? {} : { teamId }),
	});
	if (s.machineId === null) throw new Error("seeded sandbox has no machine");
	const ref = encodeUuid("sandbox", s.sandboxId);
	return {
		sandboxId: s.sandboxId,
		machineId: s.machineId,
		slug: s.slug,
		ref,
		commands: `/v1/sandboxes/${ref}/commands`,
	};
}

export interface OpenStream {
	status: number;
	headers: Headers;
	/** Parsed JSON body when the answer is not a stream. */
	body: Any;
	/** Frames read so far. */
	frames: Frame[];
	/** The next frame, or null at the end of the stream. */
	next(timeoutMs?: number): Promise<Frame | null>;
	/** Reads until `pred` holds for a frame (returned) or the stream ends (throws). */
	until(pred: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
	/** Reads to the end. */
	rest(timeoutMs?: number): Promise<Frame[]>;
	/** Cancels the body (the client goes away). */
	cancel(): Promise<void>;
}

/**
 * Sends a request and keeps an NDJSON answer open for line-by-line reads.
 * Each frame is validated against the document.
 */
export async function openStream(
	h: Harness,
	method: string,
	path: string,
	init: {
		json?: unknown;
		headers?: Record<string, string>;
		bearer?: string;
	} = {},
): Promise<OpenStream> {
	const headers = new Headers(init.headers);
	const bearer = init.bearer ?? h.bearer;
	if (bearer !== undefined && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${bearer}`);
	}
	let body: string | undefined;
	if (init.json !== undefined) {
		body = JSON.stringify(init.json);
		headers.set("content-type", "application/json");
	}
	const res = await h.app.request(path, {
		method,
		headers,
		...(body === undefined ? {} : { body }),
	});
	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.startsWith("application/x-ndjson")) {
		const text = await res.text();
		const parsed =
			contentType.includes("json") && text !== "" ? JSON.parse(text) : text;
		if (res.status !== 200 || contentType.includes("json")) {
			assertConforms(
				OPENAPI_DOC,
				method,
				path,
				res.status,
				contentType,
				parsed,
			);
		}
		const none = async () => {
			throw new Error(`not a stream: ${res.status} ${text.slice(0, 500)}`);
		};
		return {
			status: res.status,
			headers: res.headers,
			body: parsed,
			frames: [],
			next: none,
			until: none,
			rest: none,
			cancel: async () => {},
		};
	}
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const dec = new TextDecoder();
	let buf = "";
	let ended = false;
	const frames: Frame[] = [];

	async function next(timeoutMs = 20_000): Promise<Frame | null> {
		for (;;) {
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const f = JSON.parse(line) as Frame;
				const r = assertConforms(
					OPENAPI_DOC,
					method,
					path,
					200,
					contentType,
					f,
				);
				if (r.operationId !== null) validatedOperations.add(r.operationId);
				frames.push(f);
				return f;
			}
			if (ended) {
				if (buf !== "") throw new Error(`stream ended mid-line: ${buf}`);
				return null;
			}
			let timer: NodeJS.Timeout | undefined;
			const r = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`no frame within ${timeoutMs} ms`)),
						timeoutMs,
					);
				}),
			]).finally(() => clearTimeout(timer));
			if (r.done) ended = true;
			else buf += dec.decode(r.value, { stream: true });
		}
	}

	return {
		status: res.status,
		headers: res.headers,
		body: undefined,
		frames,
		next,
		async until(pred, timeoutMs) {
			for (;;) {
				const f = await next(timeoutMs);
				if (f === null) {
					throw new Error(
						`stream ended without the frame; last: ${JSON.stringify(frames.at(-1))}`,
					);
				}
				if (pred(f)) return f;
			}
		},
		async rest(timeoutMs) {
			const out: Frame[] = [];
			for (;;) {
				const f = await next(timeoutMs);
				if (f === null) return out;
				out.push(f);
			}
		},
		async cancel() {
			await reader.cancel();
		},
	};
}

export type StreamBytes = Record<"stdout" | "stderr" | "pty", Buffer>;

/**
 * Bytes of each stream from the output frames, checking that each frame
 * starts at the previous nextOffset (or after `truncated`) and that
 * `nextOffset - offset` is the byte length of the data.
 */
export function bytesOf(
	frames: Frame[],
	encoding: "utf8" | "base64" = "utf8",
	start: Partial<Record<"stdout" | "stderr" | "pty", number>> = {},
): StreamBytes {
	const parts: Record<string, Buffer[]> = { stdout: [], stderr: [], pty: [] };
	const at: Record<string, number> = {
		stdout: start.stdout ?? 0,
		stderr: start.stderr ?? 0,
		pty: start.pty ?? 0,
	};
	for (const f of frames) {
		if (f.type === "truncated") {
			at[f.stream] = f.availableFrom;
			continue;
		}
		if (f.type !== "stdout" && f.type !== "stderr" && f.type !== "pty")
			continue;
		if (f.offset !== at[f.type]) {
			throw new Error(`${f.type} frame at ${f.offset}, expected ${at[f.type]}`);
		}
		const b =
			encoding === "base64"
				? Buffer.from(f.data, "base64")
				: Buffer.from(f.data, "utf8");
		if (encoding === "base64" && b.length !== f.nextOffset - f.offset) {
			throw new Error(`frame length ${b.length} != ${f.nextOffset - f.offset}`);
		}
		parts[f.type]?.push(b);
		at[f.type] = f.nextOffset;
	}
	return {
		stdout: Buffer.concat(parts.stdout ?? []),
		stderr: Buffer.concat(parts.stderr ?? []),
		pty: Buffer.concat(parts.pty ?? []),
	};
}

export function sha256(b: Uint8Array | string): string {
	return createHash("sha256").update(b).digest("hex");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
