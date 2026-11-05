// In-process test harness: builds a listener app over test deps and sends
// requests through `app.request`. Every response is checked for the
// invariants of S7 §5.5 (a `Request-Id` header) and every JSON response for
// conformance with the committed OpenAPI document (`openapi/v1.json`).
import { readFileSync } from "node:fs";
import {
	type ApiApp,
	type ApiDeps,
	createInternalApp,
	createOpsApp,
	createProxiedApp,
	createPublicApp,
} from "../../src/index.ts";
import { makeTestDeps } from "../../src/testing/index.ts";
import {
	assertConforms,
	assertRequestConforms,
	type OpenApiDoc,
} from "./conformance.ts";
import { recordValidated } from "./conformance-coverage.ts";

export const OPENAPI_DOC = JSON.parse(
	readFileSync(new URL("../../openapi/v1.json", import.meta.url), "utf8"),
) as OpenApiDoc;

export type Listener = "public" | "proxied" | "internal" | "ops";

const REQUEST_ID_RE = /^req_[0-9a-z]{26}$/;

export interface HarnessRequest {
	headers?: Record<string, string>;
	/** Sent as `application/json` unless `headers` sets a content type. */
	json?: unknown;
	body?: BodyInit;
	/**
	 * A 2xx answer also checks the request against the document (S7 §16):
	 * params and JSON body. Pass false only for input that is deliberately
	 * outside the document.
	 */
	validateRequest?: boolean;
}

export interface HarnessResponse {
	status: number;
	headers: Headers;
	/** Parsed JSON for JSON responses, the text otherwise. */
	body: unknown;
	text: string;
	/** The raw body (binary answers such as application/proto). */
	bytes: Uint8Array;
}

export interface Harness {
	deps: ApiDeps;
	/** The default bearer of requests, if any. */
	bearer: string | undefined;
	/** The listener app: tests may add their own routes to it. */
	app: ApiApp;
	request(
		method: string,
		path: string,
		init?: HarnessRequest,
	): Promise<HarnessResponse>;
}

export interface HarnessOptions {
	listener?: Listener;
	deps?: Partial<ApiDeps>;
	/**
	 * Sent as `Authorization: Bearer <bearer>` unless a request sets its own
	 * Authorization header. `TEST_API_KEY` works with the default test deps.
	 */
	bearer?: string;
}

function build(listener: Listener, deps: ApiDeps): ApiApp {
	switch (listener) {
		case "public":
			return createPublicApp(deps);
		case "proxied":
			return createProxiedApp(deps);
		case "internal":
			return createInternalApp(deps);
		case "ops":
			return createOpsApp(deps);
	}
}

export function createHarness(o: HarnessOptions = {}): Harness {
	const listener = o.listener ?? "public";
	const deps = makeTestDeps(o.deps);
	const app = build(listener, deps);
	const documented = listener === "public" || listener === "proxied";

	async function request(
		method: string,
		path: string,
		init: HarnessRequest = {},
	): Promise<HarnessResponse> {
		const headers = new Headers({
			host: new URL(deps.settings.apiUrl).host,
			...init.headers,
		});
		if (o.bearer !== undefined && !headers.has("authorization")) {
			headers.set("authorization", `Bearer ${o.bearer}`);
		}
		let body = init.body;
		if (init.json !== undefined) {
			body = JSON.stringify(init.json);
			if (!headers.has("content-type")) {
				headers.set("content-type", "application/json");
			}
		}
		const res = await app.request(
			path,
			{
				method,
				headers,
				...(body === undefined ? {} : { body }),
			},
			{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
		);
		const bytes =
			method.toUpperCase() === "HEAD"
				? new Uint8Array()
				: new Uint8Array(await res.arrayBuffer());
		const text = new TextDecoder().decode(bytes);
		const contentType = res.headers.get("content-type") ?? "";
		const isJson = /^application\/(.+\+)?json\b/i.test(contentType);
		const isNdjson = /^application\/x-ndjson\b/i.test(contentType);
		const parsed: unknown =
			isJson && text !== ""
				? JSON.parse(text)
				: isNdjson
					? parseNdjson(text)
					: text;

		const where = `${method} ${path} -> ${res.status}`;
		if (isNdjson && documented) {
			// Every frame of an NDJSON stream conforms to the document.
			for (const frame of parsed as unknown[]) {
				const r = assertConforms(
					OPENAPI_DOC,
					method,
					path,
					res.status,
					contentType,
					frame,
				);
				recordValidated(r.operationId, res.status);
			}
		}
		if (
			documented &&
			res.status >= 200 &&
			res.status < 300 &&
			init.validateRequest !== false
		) {
			assertRequestConforms(OPENAPI_DOC, {
				method,
				path,
				contentType: headers.get("content-type"),
				json: sentJson(init, headers),
				hasBody: body !== undefined,
			});
		}
		const rid = res.headers.get("request-id");
		if (rid === null || !REQUEST_ID_RE.test(rid)) {
			throw new Error(`${where}: no valid Request-Id header (${rid})`);
		}
		// The browser endpoint of port SSO answers errors with an HTML page.
		const htmlPage =
			listener === "proxied" &&
			path.startsWith("/umiak-auth/") &&
			/^text\/html\b/i.test(contentType);
		if (res.status >= 400 && !isJson && !htmlPage) {
			throw new Error(`${where}: error without a JSON envelope`);
		}
		if (isJson && text !== "") {
			let body = parsed;
			if (listener === "internal" && res.status >= 400) {
				// The internal listener repeats the code at the top level (S4
				// gateway reads it); the rest is the common envelope.
				const { code, ...rest } = parsed as { code?: unknown };
				const inner = (rest as { error?: { code?: unknown } }).error?.code;
				if (code !== inner) {
					throw new Error(`${where}: top-level code ${code} != ${inner}`);
				}
				body = rest;
			}
			// Internal and ops answers are not in the document: only their
			// errors are checked, against the Error schema.
			if (documented || res.status >= 400) {
				const r = assertConforms(
					OPENAPI_DOC,
					method,
					documented ? path : `/__undocumented${path}`,
					res.status,
					contentType,
					body,
				);
				recordValidated(r.operationId, res.status);
			}
		}
		return {
			status: res.status,
			headers: res.headers,
			body: parsed,
			text,
			bytes,
		};
	}

	return { deps, app, bearer: o.bearer, request };
}

/** The JSON body of a request: `json`, or a string body sent as JSON. */
export function sentJson(init: HarnessRequest, headers: Headers): unknown {
	if (init.json !== undefined) return init.json;
	const type = headers.get("content-type") ?? "";
	if (typeof init.body !== "string" || !/^application\/json\b/i.test(type)) {
		return undefined;
	}
	try {
		return JSON.parse(init.body);
	} catch {
		return undefined;
	}
}

/** Lines of an NDJSON body; each must end with "\n". */
export function parseNdjson(text: string): unknown[] {
	if (text === "") return [];
	if (!text.endsWith("\n"))
		throw new Error("NDJSON body does not end with a newline");
	return text
		.slice(0, -1)
		.split("\n")
		.map((l) => JSON.parse(l) as unknown);
}
