// HTTP of the CLI outside the SDK transport: the CA-aware fetch every request
// uses (api and Keycloak), and small JSON helpers for the anonymous calls
// (`/v1/meta`, the OIDC endpoints).
//
// `--cacert <file>` / SBX_CA_FILE: a PEM bundle of a private CA. It is added
// to the default roots (not a replacement), because Keycloak and the api may
// sit behind different CAs. Bun takes it as `fetch(req, {tls: {ca}})`.

import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { NETWORK_ERROR, SbxError } from "@sbx/sdk";
import { usageError } from "./exit-codes.ts";

export type Fetch = (req: Request) => Promise<Response>;

/** fetch with the extra CA of `caFile`, or plain fetch without one. */
export function caFetch(caFile: string | undefined): Fetch {
	if (caFile === undefined || caFile === "") return (req) => fetch(req);
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
	const ca = [...rootCertificates, pem];
	// `tls` is Bun's extension of RequestInit.
	return (req) => fetch(req, { tls: { ca } } as RequestInit);
}

/** Sends a request; a failure to connect is SbxError `network_error` (retryable). */
export async function send(f: Fetch, req: Request): Promise<Response> {
	try {
		return await f(req);
	} catch (err) {
		throw new SbxError({
			status: 0,
			code: NETWORK_ERROR,
			message: `${req.method} ${req.url}: ${(err as Error).message}`,
			retryable: true,
			cause: err,
		});
	}
}

/** The API error of a non-2xx answer (envelope of S7 §5.5, or `unexpected_response`). */
export async function apiError(res: Response): Promise<SbxError> {
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
		return new SbxError({
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
	return new SbxError({
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
