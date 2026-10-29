import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
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
 * A percent-encoded "%" followed, after any further "%25" layers, by an
 * encoded ".", "/" or "\" (%252e, %252f, %255c, %25252e, ...).
 */
const multiEncodedSeparator = /%25(?:25)*(?:2e|2f|5c)/i;

/**
 * Rejects a path whose segment decodes (once, as the gateway and the agent
 * do) to "." or ".." or to one holding "/" or "\", or holds a multiply
 * encoded ".", "/" or "\": like the gateway's /files check, so a path
 * cannot reach another machine's route or another endpoint. A literal "%"
 * (%25) is allowed otherwise. The query is not checked.
 */
function checkPathSegments(path: string): void {
	const q = path.indexOf("?");
	const p = q >= 0 ? path.slice(0, q) : path;
	for (const raw of p.split("/")) {
		let seg: string;
		try {
			seg = decodeURIComponent(raw);
		} catch {
			throw new TypeError(`agent fetch path is malformed: ${path}`);
		}
		if (
			seg === "." ||
			seg === ".." ||
			/[/\\]/.test(seg) ||
			multiEncodedSeparator.test(raw)
		) {
			throw new TypeError(
				`agent fetch path must not hold ".", ".." or separators in a segment: ${path}`,
			);
		}
	}
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
 * Parses an Sbx-Upload-Offset value. It comes from the agent: only 1 to 20
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
