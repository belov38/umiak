// HTTP of the CLI outside the SDK transport: the CA-aware fetch every request
// uses (api and Keycloak), and small JSON helpers for the anonymous calls
// (`/v1/meta`, the OIDC endpoints).
//
// `--cacert <file>` / UMIAK_CA_FILE: a PEM bundle of a private CA. The trusted
// roots of the CLI's requests become Node's bundled roots
// (`tls.rootCertificates`, Mozilla's list) plus that PEM: the OS trust store
// is no longer consulted, so a corporate root installed only in the OS must
// be in the PEM too. The bundled roots stay because Keycloak and the api may
// sit behind different CAs. Bun takes it as `fetch(req, {tls: {ca}})`, and
// the PTY WebSocket of `umiak shell` as `new WebSocket(url, {tls: {ca}})`.

import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { NETWORK_ERROR, UmiakError, type WebSocketFactory } from "@umiak/sdk";
import { usageError } from "./exit-codes.ts";

export type Fetch = (req: Request) => Promise<Response>;

/**
 * The trusted roots of `caFile` (Node's bundled roots plus its PEM), or
 * undefined without one.
 */
export function caRoots(caFile: string | undefined): string[] | undefined {
	if (caFile === undefined || caFile === "") return undefined;
	let pem: string;
	try {
		pem = readFileSync(caFile, "utf8");
	} catch (err) {
		throw usageError(
			`cannot read the CA file ${caFile}: ${(err as Error).message}`,
		);
	}
	if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
		throw usageError(`${caFile} holds no PEM certificate`);
	}
	return [...rootCertificates, pem];
}

/** fetch with the extra CA of `caFile`, or plain fetch without one. */
export function caFetch(caFile: string | undefined): Fetch {
	const ca = caRoots(caFile);
	if (ca === undefined) return (req) => fetch(req);
	// `tls` is Bun's extension of RequestInit.
	return (req) => fetch(req, { tls: { ca } } as RequestInit);
}

/**
 * The SDK's WebSocket factory (the PTY of `umiak shell`) with the same roots,
 * or undefined (the SDK default) without a CA file. `tls` is Bun's
 * extension of the WebSocket constructor options.
 */
export function caWebSocket(
	caFile: string | undefined,
): WebSocketFactory | undefined {
	const ca = caRoots(caFile);
	if (ca === undefined) return undefined;
	return (url, init) =>
		new WebSocket(url, { ...init, tls: { ca } } as unknown as string[]);
}

/**
 * A signal that aborts after `ms` with a `TimeoutError`, like
 * `AbortSignal.timeout`, but held by its timer until it fires or `clear()`.
 * Unlike an otherwise unreferenced `AbortSignal.timeout`, the source stays
 * alive through GC. `send` also keeps Request's dependent controller alive.
 */
export function deadline(ms: number): { signal: AbortSignal; clear(): void } {
	const c = new AbortController();
	const timer = setTimeout(
		() => c.abort(new DOMException("The operation timed out.", "TimeoutError")),
		ms,
	);
	timer.unref?.();
	return { signal: c.signal, clear: () => clearTimeout(timer) };
}

/**
 * Sends a request; a failure to connect is UmiakError `network_error` (retryable).
 * Pass the original deadline signal to wait for its abort directly: Request's
 * weak link to its controller can disappear under GC while a fetch is pending.
 */
export async function send(
	f: Fetch,
	req: Request,
	signal?: AbortSignal,
): Promise<Response> {
	let onAbort: (() => void) | undefined;
	try {
		if (signal === undefined) return await f(req);
		signal.throwIfAborted();
		const aborted = new Promise<never>((_, reject) => {
			// The original signal keeps this listener, and thus Request and its
			// controller, alive until the request finishes or the deadline fires.
			onAbort = () =>
				reject(req.signal.aborted ? req.signal.reason : signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		return await Promise.race([f(req), aborted]);
	} catch (err) {
		throw new UmiakError({
			status: 0,
			code: NETWORK_ERROR,
			message: `${req.method} ${req.url}: ${(err as Error).message}`,
			retryable: true,
			cause: err,
		});
	} finally {
		if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
	}
}

/** The API error of a non-2xx answer (envelope of S7 §5.5, or `unexpected_response`). */
export async function apiError(res: Response): Promise<UmiakError> {
	const text = await res.text().catch(() => "");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	const e = (body as { error?: Record<string, unknown> } | undefined)?.error;
	const requestId = res.headers.get("request-id");
	if (typeof e === "object" && e !== null && typeof e.code === "string") {
		return new UmiakError({
			status: res.status,
			code: e.code,
			message: typeof e.message === "string" ? e.message : e.code,
			retryable: e.retryable === true,
			details:
				typeof e.details === "object" && e.details !== null
					? (e.details as Record<string, unknown>)
					: {},
			requestId: typeof e.requestId === "string" ? e.requestId : requestId,
		});
	}
	return new UmiakError({
		status: res.status,
		code: "unexpected_response",
		message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
		retryable: [429, 502, 503, 504].includes(res.status),
		requestId,
	});
}

/** GET of an anonymous API route, parsed as JSON. */
export async function getJson<T>(f: Fetch, url: string): Promise<T> {
	const res = await send(
		f,
		new Request(url, { headers: { accept: "application/json" } }),
	);
	if (!res.ok) throw await apiError(res);
	return (await res.json()) as T;
}
