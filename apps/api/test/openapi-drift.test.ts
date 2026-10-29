import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ANONYMOUS_ROUTES,
	buildOpenApiDocument,
	createPublicApp,
	serializeOpenApiDocument,
} from "../src/index.ts";
import { makeTestDeps } from "../src/testing/index.ts";
import { assertConforms, type OpenApiDoc } from "./helpers/conformance.ts";

const COMMITTED = readFileSync(
	new URL("../openapi/v1.json", import.meta.url),
	"utf8",
);

function generated(): string {
	return serializeOpenApiDocument(
		buildOpenApiDocument(createPublicApp(makeTestDeps())),
	);
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

interface Doc {
	openapi: string;
	security: unknown;
	paths: Record<string, Record<string, Record<string, unknown>>>;
	components: {
		schemas: Record<string, unknown>;
		securitySchemes: Record<string, Record<string, unknown>>;
	};
}

describe("openapi/v1.json", () => {
	it("equals the generated document (run `pnpm --filter @sbx/api openapi`)", () => {
		expect(generated()).toBe(COMMITTED);
	});

	it("generation is deterministic and ends with a newline", () => {
		const a = generated();
		expect(a).toBe(generated());
		expect(a.endsWith("}\n")).toBe(true);
	});

	const doc = JSON.parse(COMMITTED) as Doc;

	it("is OpenAPI 3.1 with the keycloak and teamKey schemes (S7 §15.1)", () => {
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.security).toEqual([{ keycloak: [] }, { teamKey: [] }]);
		expect(doc.components.securitySchemes.keycloak).toMatchObject({
			type: "openIdConnect",
		});
		expect(
			String(doc.components.securitySchemes.keycloak?.openIdConnectUrl),
		).toMatch(/\/\.well-known\/openid-configuration$/);
		expect(doc.components.securitySchemes.teamKey).toMatchObject({
			type: "http",
			scheme: "bearer",
			bearerFormat: "sbx_",
		});
		expect(doc.components.schemas.Error).toBeDefined();
	});

	it("every operation has a <resource>.<action> operationId, summary and description", () => {
		const ids = new Set<string>();
		let count = 0;
		for (const [path, item] of Object.entries(doc.paths)) {
			for (const [method, op] of Object.entries(item)) {
				if (!METHODS.includes(method)) continue;
				count++;
				const where = `${method.toUpperCase()} ${path}`;
				expect(op.operationId, where).toMatch(
					/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/,
				);
				expect(ids.has(op.operationId as string), where).toBe(false);
				ids.add(op.operationId as string);
				expect(String(op.summary ?? ""), where).not.toBe("");
				expect(String(op.description ?? ""), where).not.toBe("");
				// Any status may carry an error: spread ERROR_RESPONSES.
				const responses = op.responses as Record<
					string,
					{ content?: Record<string, { schema?: { $ref?: string } }> }
				>;
				expect(
					responses.default?.content?.["application/json"]?.schema?.$ref,
					where,
				).toBe("#/components/schemas/Error");
			}
		}
		expect(count).toBeGreaterThan(0);
	});

	it("meta, openapi.json and docs need no auth", () => {
		for (const p of ["/v1/meta", "/v1/openapi.json", "/v1/docs"]) {
			expect(doc.paths[p]?.get?.security, p).toEqual([]);
		}
		expect(doc.paths["/v1/openapi.json"]?.get?.operationId).toBe(
			"meta.openapi",
		);
		expect(doc.paths["/v1/docs"]?.get?.operationId).toBe("meta.docs");
	});

	it("operations with security: [] are exactly the routes the listeners leave anonymous", () => {
		const anonymous: string[] = [];
		for (const [path, item] of Object.entries(doc.paths)) {
			for (const m of METHODS) {
				const sec = item[m]?.security;
				if (Array.isArray(sec) && sec.length === 0) anonymous.push(path);
			}
		}
		// Hono templates use :param, the document {param}.
		const routes = [...ANONYMOUS_ROUTES].map((r) =>
			r.replace(/:([^/]+)/g, "{$1}"),
		);
		expect(anonymous.sort()).toEqual(routes.sort());
	});

	it("the PTY WebSocket is a GET with 101 and x-sbx-websocket (§15.1)", () => {
		const op = doc.paths["/v1/sandboxes/{sandbox}/ptys/{command}/connect"]?.get;
		expect(op?.operationId).toBe("ptys.connect");
		expect(Object.keys(op?.responses as object)).toContain("101");
		expect(op?.["x-sbx-websocket"]).toEqual({ subprotocol: "sbx.pty.v1" });
	});

	it("has no warm pool terms (no failFast, pool_exhausted, warmAvailable)", () => {
		for (const s of ["failFast", "pool_exhausted", "warmAvailable"]) {
			expect(COMMITTED).not.toContain(s);
		}
	});

	describe("assertConforms", () => {
		const d = doc as unknown as OpenApiDoc;
		const meta = {
			apiVersion: "v1",
			build: "dev",
			appUrl: "https://app.x.test",
			apiUrl: "https://api.x.test",
			sbxDomain: "x.test",
			oidc: null,
			ssh: { host: "ssh.x.test", port: 22, hostKeys: [] },
			minCliVersion: null,
			latestCliVersion: null,
		};
		const error = {
			error: {
				code: "x",
				message: "m",
				retryable: false,
				details: {},
				requestId: "req_1",
			},
		};

		it("accepts documented responses", () => {
			expect(
				assertConforms(d, "GET", "/v1/meta", 200, "application/json", meta),
			).toEqual({ operationId: "meta.get" });
			expect(
				assertConforms(d, "GET", "/v1/meta?x=1", 503, "application/json", error)
					.operationId,
			).toBe("meta.get");
			expect(
				assertConforms(d, "GET", "/v1/nope", 404, "application/json", error),
			).toEqual({ operationId: null });
		});

		it("is strict: undocumented response fields fail, at any depth", () => {
			expect(() =>
				assertConforms(d, "GET", "/v1/meta", 200, "application/json", {
					...meta,
					request: { bodyHash: "x" },
				}),
			).toThrow(/unevaluated/);
			expect(() =>
				assertConforms(d, "GET", "/v1/meta", 200, "application/json", {
					...meta,
					ssh: { ...meta.ssh, extra: 1 },
				}),
			).toThrow(/unevaluated/);
			expect(() =>
				assertConforms(d, "GET", "/v1/nope", 404, "application/json", {
					...error,
					code: "x",
				}),
			).toThrow(/unevaluated/);
			// Free-form maps stay open.
			expect(() =>
				assertConforms(d, "GET", "/v1/nope", 404, "application/json", {
					error: { ...error.error, details: { anything: 1 } },
				}),
			).not.toThrow();
		});

		it("rejects bodies, statuses and paths the document does not describe", () => {
			const { ssh: _, ...noSsh } = meta;
			expect(() =>
				assertConforms(d, "GET", "/v1/meta", 200, "application/json", noSsh),
			).toThrow(/ssh/);
			expect(() =>
				assertConforms(d, "GET", "/v1/meta", 200, "text/plain", meta),
			).toThrow(/content type/);
			expect(() =>
				assertConforms(d, "GET", "/v1/nope", 200, "application/json", {}),
			).toThrow(/undocumented/);
			expect(() =>
				assertConforms(d, "GET", "/v1/meta", 500, "application/json", {
					error: { code: "x" },
				}),
			).toThrow(/does not match/);
		});
	});
});
