import {
	CODE_AGENT_UNAVAILABLE,
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
	const { body, headers, signal, ...rest } = init;
	const headerEntries = [...new Headers(headers).entries()];
	const factory =
		typeof body === "function" ? (body as () => BodyInit) : undefined;
	const fixed =
		factory === undefined ? (body as BodyInit | null | undefined) : undefined;
	const oneShot = fixed != null && !resendable(fixed);
	let sent = false;

	return routeCall(
		{
			...routing,
			signal: signal ?? undefined,
			abortError: (reason) => reason,
		},
		async ({ instanceUrl, authorization }) => {
			const url = `${instanceUrl.replace(/\/+$/, "")}/v1/machines/${routing.machineId}/files${path}`;
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
