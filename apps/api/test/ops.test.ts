import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiMetrics, bodyLimitFor } from "../src/index.ts";
import { captureLogs } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

describe("ops listener", () => {
	it("/healthz answers 200", async () => {
		const h = createHarness({ listener: "ops" });
		const r = await h.request("GET", "/healthz");
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true });
	});

	it("/readyz is 503 when Postgres does not answer", async () => {
		const pool = new pg.Pool({
			connectionString: "postgres://sbx:sbx@127.0.0.1:1/none",
			connectionTimeoutMillis: 500,
		});
		try {
			const h = createHarness({ listener: "ops", deps: { pool } });
			const r = await h.request("GET", "/readyz");
			expect(r.status).toBe(503);
			expect(r.body).toMatchObject({ ready: false, reasons: ["postgres"] });
		} finally {
			await pool.end();
		}
	});

	describe("with Postgres", () => {
		let db: TestDatabase;
		beforeAll(async () => {
			db = await createTestDatabase();
		});
		afterAll(() => db?.drop());

		it("/readyz is 200 when Postgres answers", async () => {
			const h = createHarness({ listener: "ops", deps: { pool: db.pool } });
			const r = await h.request("GET", "/readyz");
			expect(r.status).toBe(200);
			expect(r.body).toEqual({ ready: true, reasons: [] });
		});
	});

	it("/metrics exposes request counts per route, method and status", async () => {
		const metrics = new ApiMetrics();
		const pub = createHarness({ deps: { metrics } });
		await pub.request("GET", "/v1/meta");
		await pub.request("GET", "/v1/nope/123");
		const ops = createHarness({ listener: "ops", deps: { metrics } });
		const r = await ops.request("GET", "/metrics");
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/plain");
		const text = r.text;
		expect(text).toMatch(
			/sbx_api_requests_total\{[^}]*route="\/v1\/meta"[^}]*method="GET"[^}]*status="200"[^}]*\} 1/,
		);
		// Unknown paths share one label value (no cardinality from URLs).
		expect(text).toMatch(/route="unmatched"[^}]*status="404"/);
		expect(text).not.toContain("/v1/nope/123");
		expect(text).toContain("sbx_api_request_duration_seconds_bucket");
	});
});

describe("request log", () => {
	it("one line per request with the request id; a valid client Request-Id as clientRequestId", async () => {
		const logs = captureLogs();
		const h = createHarness({ deps: { log: logs.log } });
		const r = await h.request("GET", "/v1/meta", {
			headers: { "request-id": "ci-run.42_a-b" },
		});
		const line = logs.entries().find((e) => e.msg === "request");
		expect(line).toMatchObject({
			requestId: r.headers.get("request-id"),
			clientRequestId: "ci-run.42_a-b",
			method: "GET",
			path: "/v1/meta",
			route: "/v1/meta",
			status: 200,
		});
		expect(typeof line?.durationMs).toBe("number");
	});

	it("an invalid client Request-Id is ignored", async () => {
		const logs = captureLogs();
		const h = createHarness({ deps: { log: logs.log } });
		await h.request("GET", "/v1/meta", {
			headers: { "request-id": `bad id ${"x".repeat(200)}` },
		});
		const line = logs.entries().find((e) => e.msg === "request");
		expect(line).toBeDefined();
		expect(line).not.toHaveProperty("clientRequestId");
	});

	it("an internal error is logged with its message; errors carry their code", async () => {
		const logs = captureLogs();
		const h = createHarness({ deps: { log: logs.log } });
		h.app.get("/v1/__test/boom", () => {
			throw new Error("db exploded");
		});
		await h.request("GET", "/v1/__test/boom");
		const err = logs.entries().find((e) => e.level === 50);
		expect(err).toMatchObject({ err: "db exploded" });
		const line = logs.entries().find((e) => e.msg === "request");
		expect(line).toMatchObject({ status: 500, code: "internal" });
	});

	it("redacts secret-bearing fields and the authorization header", () => {
		const logs = captureLogs();
		logs.log.info(
			{
				req: { headers: { authorization: "Bearer sbx_secret" } },
				body: {
					env: { A: "1" },
					secrets: { B: "2" },
					secretFiles: [],
					secret: "s",
					token: "t",
					code: "c",
					contentBase64: "Zm9v",
				},
			},
			"x",
		);
		const text = JSON.stringify(logs.entries());
		for (const s of ["sbx_secret", '"1"', '"2"', '"s"', '"t"', '"c"', "Zm9v"]) {
			expect(text).not.toContain(s);
		}
	});
});

describe("body limits (S7 §5.11)", () => {
	it("route table", () => {
		const MiB = 1024 * 1024;
		expect(bodyLimitFor("GET", "/v1/meta")).toBe(MiB);
		expect(bodyLimitFor("POST", "/v1/sandboxes")).toBe(12 * MiB);
		expect(bodyLimitFor("POST", "/v1/sandboxes/sb_x/fork")).toBe(12 * MiB);
		expect(bodyLimitFor("PUT", "/v1/sandboxes/quiet-otter/env")).toBe(12 * MiB);
		expect(bodyLimitFor("PUT", "/v1/sandboxes/sb_x/files/content")).toBeNull();
		expect(bodyLimitFor("PUT", "/v1/sandboxes/sb_x/files/uploads/upl_y")).toBe(
			8 * MiB,
		);
		expect(bodyLimitFor("POST", "/internal/v1/agent-events")).toBe(16 * MiB);
		expect(bodyLimitFor("POST", "/v1/sandboxes/sb_x/commands")).toBe(MiB);
	});
});
