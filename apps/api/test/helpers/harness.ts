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
import { assertConforms, type OpenApiDoc } from "./conformance.ts";

export const OPENAPI_DOC = JSON.parse(
	readFileSync(new URL("../../openapi/v1.json", import.meta.url), "utf8"),
) as OpenApiDoc;

/** Operations with at least one validated response in this test file. */
export const validatedOperations = new Set<string>();

export type Listener = "public" | "proxied" | "internal" | "ops";

const REQUEST_ID_RE = /^req_[0-9a-z]{26}$/;

export interface HarnessRequest {
	headers?: Record<string, string>;
	/** Sent as `application/json` unless `headers` sets a content type. */
	json?: unknown;
	body?: BodyInit;
}

export interface HarnessResponse {
	status: number;
	headers: Headers;
	/** Parsed JSON for JSON responses, the text otherwise. */
	body: unknown;
	text: string;
}

export interface Harness {
	deps: ApiDeps;
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
		const headers = new Headers(init.headers);
		let body = init.body;
		if (init.json !== undefined) {
			body = JSON.stringify(init.json);
			if (!headers.has("content-type")) {
				headers.set("content-type", "application/json");
			}
		}
		const res = await app.request(path, {
			method,
			headers,
			...(body === undefined ? {} : { body }),
		});
		const text = method.toUpperCase() === "HEAD" ? "" : await res.text();
		const contentType = res.headers.get("content-type") ?? "";
		const isJson = /^application\/(.+\+)?json\b/i.test(contentType);
		const parsed: unknown = isJson && text !== "" ? JSON.parse(text) : text;

		const where = `${method} ${path} -> ${res.status}`;
		const rid = res.headers.get("request-id");
		if (rid === null || !REQUEST_ID_RE.test(rid)) {
			throw new Error(`${where}: no valid Request-Id header (${rid})`);
		}
		if (res.status >= 400 && !isJson) {
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
				if (r.operationId !== null) validatedOperations.add(r.operationId);
			}
		}
		return { status: res.status, headers: res.headers, body: parsed, text };
	}

	return { deps, app, request };
}
