import {
	CODE_AGENT_UNAVAILABLE,
	HEADER_ERROR_CODE,
	HEADER_INSTANCE_URL,
	SCHEME_BEARER,
} from "./constants.js";
import { type RoutingOptions, routeCall } from "./routing.js";

/** Request options of AgentClient.fetch. */
export interface AgentFetchInit extends Omit<RequestInit, "body"> {
	/**
	 * Resendable bodies (string, Uint8Array, ArrayBuffer, Blob, URLSearchParams,
	 * FormData) or a factory are retried; a one-shot ReadableStream body is sent
	 * once and never retried after it started.
	 */
	body?: BodyInit | null | (() => BodyInit);
}

type FetchRouting = Omit<RoutingOptions, "signal" | "abortError"> & {
	serviceToken: string;
};

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
		async (instanceUrl) => {
			const url = `${instanceUrl.replace(/\/+$/, "")}/v1/machines/${routing.machineId}/files${path}`;
			const h = new Headers(headerEntries);
			h.set("Authorization", `${SCHEME_BEARER} ${routing.serviceToken}`);
			const b = factory !== undefined ? factory() : fixed;
			const req: RequestInit & { duplex?: "half" } = {
				...rest,
				headers: h,
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
				if (signal?.aborted || oneShot) {
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
			await res.body?.cancel().catch(() => {});
			const cause = new Error(
				`gateway ${instanceUrl} answered ${res.status} ${res.headers.get(HEADER_ERROR_CODE) ?? ""}`.trim(),
			);
			if (moved) {
				return {
					kind: "moved",
					instanceUrl: res.headers.get(HEADER_INSTANCE_URL) ?? undefined,
					cause,
				};
			}
			return { kind: "unavailable", cause };
		},
	);
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
