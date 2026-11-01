import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiMetrics, bodyLimitFor } from "../src/index.ts";
import { captureLogs, TEST_API_KEY } from "../src/testing/index.ts";
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
			connectionString: "postgres://umiak:umiak@127.0.0.1:1/none",
			connectionTimeoutMillis: 500,
		});
		try {
			const h = createHarness({ listener: "ops", deps: { pool } });
			const r = await h.request("GET", "/readyz");
			expect(r.status).toBe(503);
			expect(r.headers.get("retry-after")).toBe("5");
			expect(r.body).toMatchObject({
				error: {
					code: "not_ready",
					retryable: true,
					details: { reasons: ["postgres"], retryAfterSeconds: 5 },
					requestId: r.headers.get("request-id"),
				},
			});
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
		pub.app.post("/v1/__test/upload", (c) => c.body(null, 204));
		await pub.request("GET", "/v1/meta");
		await pub.request("GET", "/v1/nope/123");
		const ops = createHarness({ listener: "ops", deps: { metrics } });
		const r = await ops.request("GET", "/metrics");
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("text/plain");
		const text = r.text;
		expect(text).toMatch(
			/umiak_api_requests_total\{[^}]*route="\/v1\/meta"[^}]*method="GET"[^}]*status="200"[^}]*\} 1/,
		);
		// Answers produced in middleware keep the route label (413 here).
		const big = await pub.request("POST", "/v1/__test/upload", {
			headers: { "content-type": "application/json" },
			body: "x".repeat(1024 * 1024 + 1),
		});
		expect(big.status).toBe(413);
		const text2 = (await ops.request("GET", "/metrics")).text;
		expect(text2).toMatch(
			/umiak_api_requests_total\{[^}]*route="\/v1\/__test\/upload"[^}]*status="413"[^}]*\} 1/,
		);
		// Unknown paths share one label value (no cardinality from URLs).
		expect(text).toMatch(/route="unmatched"[^}]*status="404"/);
		expect(text).not.toContain("/v1/nope/123");
		expect(text).toContain("umiak_api_request_duration_seconds_bucket");
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
		const h = createHarness({ deps: { log: logs.log }, bearer: TEST_API_KEY });
		h.app.get("/v1/__test/boom", () => {
			throw new Error("db exploded");
		});
		await h.request("GET", "/v1/__test/boom");
		await h.request("GET", "/v1/__test/boom", {
			headers: { "request-id": "client-7" },
		});
		const errs = logs.entries().filter((e) => e.level === 50);
		expect(errs[0]).toMatchObject({ err: "db exploded" });
		expect(errs[0]).not.toHaveProperty("clientRequestId");
		expect(errs[1]).toMatchObject({
			err: "db exploded",
			clientRequestId: "client-7",
		});
		const line = logs.entries().find((e) => e.msg === "request");
		expect(line).toMatchObject({ status: 500, code: "internal" });
	});

	it("redacts secret-bearing fields and the authorization header", () => {
		const logs = captureLogs();
		logs.log.info(
			{
				req: { headers: { authorization: "Bearer umiak_secret" } },
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
		for (const s of [
			"umiak_secret",
			'"1"',
			'"2"',
			'"s"',
			'"t"',
			'"c"',
			"Zm9v",
		]) {
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
