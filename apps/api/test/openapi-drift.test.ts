import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ANONYMOUS_ROUTES,
	buildOpenApiDocument,
	createPublicApp,
	serializeOpenApiDocument,
} from "../src/index.ts";
import { makeTestDeps } from "../src/testing/index.ts";
import {
	assertConforms,
	assertRequestConforms,
	type OpenApiDoc,
} from "./helpers/conformance.ts";
import {
	coverageProblems,
	documentOperations,
	NON_JSON_SUCCESS,
} from "./helpers/conformance-global.ts";

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
	it("equals the generated document (run `pnpm --filter @umiak/api openapi`)", () => {
		expect(generated()).toBe(COMMITTED);
	});

	it("generation is deterministic and ends with a newline", () => {
		const a = generated();
		expect(a).toBe(generated());
		expect(a.endsWith("}\n")).toBe(true);
	});

	const doc = JSON.parse(COMMITTED) as Doc;

	it("is OpenAPI 3.1 with the owner and teamKey schemes (S7 §15.1)", () => {
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.security).toEqual([{ owner: [] }, { teamKey: [] }]);
		expect(doc.components.securitySchemes.owner).toMatchObject({
			type: "http",
			scheme: "bearer",
		});

		expect(doc.components.securitySchemes.teamKey).toMatchObject({
			type: "http",
			scheme: "bearer",
			bearerFormat: "umiak_",
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
		for (const p of ["/v1/meta", "/v1/openapi.json"]) {
			expect(doc.paths[p]?.get?.security, p).toEqual([]);
		}
		expect(doc.paths["/v1/openapi.json"]?.get?.operationId).toBe(
			"meta.openapi",
		);
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

	it("the PTY WebSocket is a GET with 101 and x-umiak-websocket (§15.1)", () => {
		const op = doc.paths["/v1/sandboxes/{sandbox}/ptys/{command}/connect"]?.get;
		expect(op?.operationId).toBe("ptys.connect");
		expect(Object.keys(op?.responses as object)).toContain("101");
		expect(op?.["x-umiak-websocket"]).toEqual({ subprotocol: "umiak.pty.v1" });
	});

	it("every pattern is a JSON Schema regex (ECMA-262 source, no /flags suffix)", () => {
		const patterns: string[] = [];
		const walk = (v: unknown): void => {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v !== null && typeof v === "object") {
				for (const [k, x] of Object.entries(v)) {
					if (k === "pattern" && typeof x === "string") patterns.push(x);
					else walk(x);
				}
			}
		};
		walk(JSON.parse(COMMITTED));
		expect(patterns.length).toBeGreaterThan(5);
		for (const p of patterns) {
			expect(p, p).not.toMatch(/\/[a-z]*$/);
			expect(() => new RegExp(p, "u"), p).not.toThrow();
		}
	});

	it("a name refuses control characters, as the API does: C0, DEL and C1", () => {
		const doc = JSON.parse(COMMITTED) as Doc;
		const name = (
			doc.components.schemas.CreateApiKeyRequest as {
				properties: { name: { pattern: string } };
			}
		).properties.name.pattern;
		const re = new RegExp(name, "u");
		expect(re.test("ci-main ✓ ключ")).toBe(true);
		for (const bad of ["a\u0000", "a\nb", "a\u007f", "a\u0085", "a\u009f"]) {
			expect(re.test(bad), JSON.stringify(bad)).toBe(false);
		}
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
			umiakDomain: "x.test",
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

describe("conformance coverage (global teardown)", () => {
	const doc = JSON.parse(COMMITTED) as Doc;
	const ops = documentOperations(doc);
	const all = (n: { ok: number; error: number }) =>
		new Map([...ops.keys()].map((id) => [id, { ...n }]));

	it("NON_JSON_SUCCESS is exactly the document's operations without a JSON success answer", () => {
		const nonJson = [...ops].filter(([, json]) => !json).map(([id]) => id);
		expect(nonJson.sort()).toEqual([...NON_JSON_SUCCESS].sort());
		expect(coverageProblems(ops, all({ ok: 1, error: 0 }))).toEqual([]);
	});

	it("an operation never validated is a problem; HEAD and the HTML page are exempt", () => {
		const counts = all({ ok: 1, error: 0 });
		counts.delete("sandboxes.get");
		counts.delete("files.downloadHead");
		counts.delete("meta.docs");
		expect(coverageProblems(ops, counts)).toEqual([
			"sandboxes.get: no success answer was validated",
		]);
	});

	it("an operation with a JSON success answer needs a validated success; others any validated answer", () => {
		const counts = all({ ok: 0, error: 1 });
		const problems = coverageProblems(ops, counts);
		const missing = problems.map((p) => p.split(":")[0]);
		expect(missing).toContain("sandboxes.create");
		expect(missing).not.toContain("files.download");
		expect(missing.sort()).toEqual(
			[...ops]
				.filter(([, json]) => json)
				.map(([id]) => id)
				.sort(),
		);
	});

	it("a non-JSON operation missing from NON_JSON_SUCCESS is a problem", () => {
		const extended = new Map(ops).set("things.raw", false);
		const counts = all({ ok: 1, error: 0 }).set("things.raw", {
			ok: 0,
			error: 1,
		});
		expect(coverageProblems(extended, counts)).toEqual([
			"things.raw has no JSON success answer: add it to NON_JSON_SUCCESS",
		]);
	});
});

describe("assertRequestConforms (requests of 2xx answers)", () => {
	const d = JSON.parse(COMMITTED) as OpenApiDoc;
	const check =
		(
			method: string,
			path: string,
			json?: unknown,
			hasBody = json !== undefined,
		) =>
		() =>
			assertRequestConforms(d, { method, path, json, hasBody });

	it("accepts documented params and bodies, numbers and repeats from the query", () => {
		expect(check("GET", "/v1/sandboxes?limit=5&label=a=1&label=b=2")()).toEqual(
			{
				operationId: "sandboxes.list",
			},
		);
		expect(
			check("PUT", "/v1/sandboxes/sb_x/ports/3000", { access: "token" }),
		).not.toThrow();
		expect(
			check("POST", "/v1/sandboxes/sb_x/commands", { command: "true" }),
		).not.toThrow();
		expect(
			check(
				"GET",
				"/v1/sandboxes/sb_x/commands/cmd_x/stream?stdoutOffset=0&follow=false",
			),
		).not.toThrow();
	});

	it("refuses unknown body fields, bad types, bad query and path params, missing bodies", () => {
		expect(check("POST", "/v1/sandboxes", { failFast: true })).toThrow(/body/);
		expect(
			check("POST", "/v1/sandboxes/sb_x/commands/cmd_x/signal", {
				signal: "SIGFOO",
			}),
		).toThrow(/body/);
		expect(check("GET", "/v1/sandboxes?limit=abc")).toThrow(/query.limit/);
		expect(check("GET", "/v1/sandboxes?limit=500")).toThrow(/query.limit/);
		expect(check("PUT", "/v1/sandboxes/sb_x/ports/0", {})).toThrow(/path.port/);
		expect(check("GET", "/v1/sandboxes/sb_x/files/stat")).toThrow(
			/query.path is required/,
		);
		expect(check("POST", "/v1/environments")).toThrow(/body is required/);
		expect(check("POST", "/v1/sandboxes/sb_x/stop", {})).toThrow(
			/documents none/,
		);
	});

	it("leaves operations the document does not have to the response check", () => {
		expect(check("GET", "/v1/__test/x")()).toEqual({ operationId: null });
	});
});
