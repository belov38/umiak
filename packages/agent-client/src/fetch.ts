import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@umiak/proto";
import {
	CODE_AGENT_UNAVAILABLE,
	CODE_BAD_AGENT_RESPONSE,
	HEADER_ERROR_CODE,
	HEADER_INSTANCE_URL,
} from "./constants.js";
import { isConnectionError } from "./errors.js";
import { type CallRoutingOptions, routeCall } from "./routing.js";

/** Request options of AgentClient.fetch. */
export interface AgentFetchInit extends Omit<RequestInit, "body"> {
	/**
	 * Resendable bodies (string, Uint8Array, ArrayBuffer, Blob, URLSearchParams,
	 * FormData) or a factory are retried; a one-shot ReadableStream body is sent
	 * once and never retried after it started.
	 */
	body?: BodyInit | null | (() => BodyInit);
	/**
	 * Ignored: redirects are never followed (always "manual"). A 3xx from
	 * the agent is returned as the Response.
	 */
	redirect?: RequestRedirect;
}

type FetchRouting = Omit<CallRoutingOptions, "signal" | "abortError">;

/** Implements AgentClient.fetch on the shared routing loop. */
export async function routedFetch(
	routing: FetchRouting,
	path: string,
	init: AgentFetchInit,
): Promise<Response> {
	if (path !== "" && !path.startsWith("/") && !path.startsWith("?")) {
		throw new TypeError(`agent fetch path must start with "/": ${path}`);
	}
	checkPathSegments(path);
	const { body, headers, signal, ...rest } = init;
	const h0 = new Headers(headers);
	// undici inflates any Content-Encoding the answer names, whatever was
	// asked for: an agent's small body could become a huge one. Without a
	// caller's Accept-Encoding, ask for identity and refuse anything else.
	const ownEncoding = !h0.has("accept-encoding");
	if (ownEncoding) {
		h0.set("accept-encoding", "identity");
	}
	const headerEntries = [...h0.entries()];
	const factory =
		typeof body === "function" ? (body as () => BodyInit) : undefined;
	const fixed =
		factory === undefined ? (body as BodyInit | null | undefined) : undefined;
	const oneShot = fixed != null && !resendable(fixed);
	let sent = false;

	const res = await routeCall(
		{
			...routing,
			signal: signal ?? undefined,
			abortError: (reason) => reason,
		},
		async ({ instanceUrl, authorization }) => {
			const base = `${instanceUrl.replace(/\/+$/, "")}/v1/machines/${routing.machineId}/files`;
			const url = `${base}${path}`;
			// Belt and braces: the request must stay under this machine's files.
			const prefix = new URL(base).pathname;
			const got = new URL(url).pathname;
			if (got !== prefix && !got.startsWith(`${prefix}/`)) {
				throw new TypeError(`agent fetch path leaves /files: ${path}`);
			}
			const h = new Headers(headerEntries);
			h.set("Authorization", authorization);
			const b = factory !== undefined ? factory() : fixed;
			const req: RequestInit & { duplex?: "half" } = {
				...rest,
				headers: h,
				// Never follow: a redirect comes from the agent and would carry
				// the request (and the service token) to a URL it chose.
				redirect: "manual",
			};
			if (b != null) {
				req.body = b;
				if (b instanceof ReadableStream) {
					req.duplex = "half";
				}
			}
			if (signal != null) {
				req.signal = signal;
			}
			if (oneShot && sent) {
				// routeCall never gets here: a sent one-shot body ends the loop.
				throw new Error("one-shot body already sent");
			}
			sent = true;
			let res: Response;
			try {
				res = await fetch(url, req);
			} catch (err) {
				if (signal?.aborted || oneShot || !isFetchConnectionError(err)) {
					throw err;
				}
				return { kind: "unavailable", cause: err };
			}
			const moved = res.status === 421;
			const unavailable =
				res.status === 503 &&
				res.headers.get(HEADER_ERROR_CODE) === CODE_AGENT_UNAVAILABLE;
			if (!(moved || unavailable) || oneShot) {
				return { kind: "done", value: res };
			}
			const cause = new Error(
				`gateway ${instanceUrl} answered ${res.status} ${res.headers.get(HEADER_ERROR_CODE) ?? ""}`.trim(),
			);
			const discard = () => {
				res.body?.cancel().catch(() => {});
			};
			if (moved) {
				// Not followed (no live instance at the hint): an ordinary answer.
				return {
					kind: "moved",
					instanceUrl: res.headers.get(HEADER_INSTANCE_URL) ?? undefined,
					cause,
					notMoved: () => ({ kind: "done", value: res }),
					discard,
				};
			}
			discard();
			return { kind: "unavailable", cause };
		},
	);
	if (ownEncoding && !isIdentity(res.headers.get("content-encoding"))) {
		res.body?.cancel().catch(() => {});
		throw new ConnectError(
			`agent answered with Content-Encoding ${JSON.stringify(res.headers.get("content-encoding"))} to Accept-Encoding: identity`,
			Code.Internal,
			undefined,
			[
				{
					desc: ErrorDetailSchema,
					value: { code: CODE_BAD_AGENT_RESPONSE, retryable: false },
				},
			],
		);
	}
	return res;
}

/** True for an absent, empty or identity Content-Encoding. */
function isIdentity(encoding: string | null): boolean {
	const e = encoding?.trim().toLowerCase() ?? "";
	return e === "" || e === "identity";
}

/**
 * Rejects a path with a segment that decodes to "." or ".." or to one
 * holding "/" or "\", at any layer: the first decode (as the gateway and the
 * agent do) and every further one, so a multiply encoded traversal or
 * separator (%252e, %25%32%65, ...) is refused too. A segment that fails the
 * first decode is malformed. Later layers are decoded to bytes like Go's
 * url.PathUnescape: an escape need not be UTF-8 (%25FF is a literal "%FF"),
 * and only a "%" without two hex digits after it, in a layer that holds an
 * escape sequence, is malformed (%252f%25zz). A layer without an escape
 * sequence ends the check for that segment, so a literal "%" (%25, %25%25)
 * is allowed. The query is not checked.
 */
function checkPathSegments(path: string): void {
	const q = path.indexOf("?");
	const p = q >= 0 ? path.slice(0, q) : path;
	for (const raw of p.split("/")) {
		let seg: Uint8Array;
		try {
			seg = new TextEncoder().encode(decodeURIComponent(raw));
		} catch {
			throw new TypeError(`agent fetch path is malformed: ${path}`);
		}
		// Every layer is shorter than the one before, so this ends.
		for (;;) {
			if (isDotSegment(seg) || seg.includes(0x2f) || seg.includes(0x5c)) {
				throw new TypeError(
					`agent fetch path must not hold ".", ".." or separators in a segment: ${path}`,
				);
			}
			if (!hasEscape(seg)) {
				break;
			}
			const next = percentDecode(seg);
			if (next === undefined) {
				throw new TypeError(`agent fetch path is malformed: ${path}`);
			}
			seg = next;
		}
	}
}

function isHex(b: number | undefined): boolean {
	return (
		b !== undefined &&
		((b >= 0x30 && b <= 0x39) ||
			(b >= 0x41 && b <= 0x46) ||
			(b >= 0x61 && b <= 0x66))
	);
}

function hexValue(b: number): number {
	return b <= 0x39 ? b - 0x30 : (b | 0x20) - 0x61 + 10;
}

/** True for "." or "..". */
function isDotSegment(b: Uint8Array): boolean {
	return (
		(b.length === 1 && b[0] === 0x2e) ||
		(b.length === 2 && b[0] === 0x2e && b[1] === 0x2e)
	);
}

/** True when b holds a "%" followed by two hex digits. */
function hasEscape(b: Uint8Array): boolean {
	for (let i = 0; i + 2 < b.length; i++) {
		if (b[i] === 0x25 && isHex(b[i + 1]) && isHex(b[i + 2])) {
			return true;
		}
	}
	return false;
}

/**
 * Decodes %XX escapes to bytes, as Go's url.PathUnescape: undefined when a
 * "%" is not followed by two hex digits.
 */
function percentDecode(b: Uint8Array): Uint8Array | undefined {
	const out = new Uint8Array(b.length);
	let n = 0;
	for (let i = 0; i < b.length; i++) {
		const c = b[i] as number;
		if (c !== 0x25) {
			out[n++] = c;
			continue;
		}
		const hi = b[i + 1];
		const lo = b[i + 2];
		if (hi === undefined || lo === undefined || !isHex(hi) || !isHex(lo)) {
			return undefined;
		}
		out[n++] = hexValue(hi) * 16 + hexValue(lo);
		i += 2;
	}
	return out.subarray(0, n);
}

/**
 * Reads a whole Response body, failing with ResourceExhausted as soon as it
 * exceeds maxBytes (decoded bytes, as the body yields them); the rest of the
 * body is cancelled. maxBytes is a non-negative safe integer (else it
 * rejects with a RangeError). Use it instead of arrayBuffer(), text() or
 * json() on an agent answer.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError(
			`maxBytes must be a non-negative safe integer: ${maxBytes}`,
		);
	}
	const reader = response.body?.getReader();
	if (reader === undefined) {
		return new Uint8Array();
	}
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new ConnectError(
				`agent response body is larger than ${maxBytes} bytes`,
				Code.ResourceExhausted,
			);
		}
		parts.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

const maxUploadOffset = (1n << 63n) - 1n;

/**
 * Parses an Umiak-Upload-Offset value. It comes from the agent: only 1 to 20
 * ASCII digits up to 2^63-1 are accepted, anything else (signs, spaces,
 * exponents, a list, an absent header) yields undefined.
 */
export function parseUploadOffset(value: string | null): bigint | undefined {
	if (value === null || !/^[0-9]{1,20}$/.test(value)) {
		return undefined;
	}
	const n = BigInt(value);
	return n <= maxUploadOffset ? n : undefined;
}

/** undici error codes of a failed or broken connection. */
const undiciConnectionCodes = new Set([
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_CLOSED",
]);

/**
 * True for a network failure of fetch: undici's TypeError("fetch failed")
 * whose cause carries a network, HTTP/2 or undici socket code. Other errors
 * (a TypeError for an invalid request, programming errors) are not retried.
 */
function isFetchConnectionError(err: unknown): boolean {
	if (isConnectionError(err)) {
		return true;
	}
	let e: unknown = err;
	for (
		let depth = 0;
		depth < 5 && e != null && typeof e === "object";
		depth++
	) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === "string" && undiciConnectionCodes.has(code)) {
			return true;
		}
		e = (e as { cause?: unknown }).cause;
	}
	return false;
}

function resendable(body: BodyInit): boolean {
	return (
		typeof body === "string" ||
		body instanceof ArrayBuffer ||
		ArrayBuffer.isView(body) ||
		body instanceof Blob ||
		body instanceof URLSearchParams ||
		body instanceof FormData
	);
}
