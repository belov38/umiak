import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiCallLogger, createLogger, REDACT_PATHS } from "../src/log.ts";

function capture(level = "info") {
	const lines: Record<string, unknown>[] = [];
	const log = createLogger({
		level,
		destination: { write: (s: string) => lines.push(JSON.parse(s)) },
	});
	return { log, lines };
}

describe("createLogger", () => {
	it("redacts secret-bearing fields one level down", () => {
		const { log, lines } = capture();
		log.info(
			{
				args: {
					content: "c",
					old_text: "o",
					new_text: "n",
					text: "t",
					env: { A: "1" },
					command: "curl -H token",
					path: "/kept",
				},
				headers: { authorization: "Bearer x" },
				req: { headers: { authorization: "Bearer y" } },
			},
			"m",
		);
		const line = lines[0] as {
			args: Record<string, unknown>;
			headers: Record<string, unknown>;
			req: { headers: Record<string, unknown> };
		};
		for (const k of [
			"content",
			"old_text",
			"new_text",
			"text",
			"env",
			"command",
		])
			expect(line.args[k]).toBe("[redacted]");
		expect(line.args.path).toBe("/kept");
		expect(line.headers.authorization).toBe("[redacted]");
		expect(line.req.headers.authorization).toBe("[redacted]");
		expect(REDACT_PATHS).toContain("*.authorization");
	});

	it("honours the level", () => {
		const { log, lines } = capture("warn");
		log.info("dropped");
		log.warn("kept");
		expect(lines.map((l) => l.msg)).toEqual(["kept"]);
	});

	it("writes to a file path", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-mcp-log-"));
		try {
			const file = join(dir, "mcp.log");
			const log = createLogger({ level: "info", destination: file });
			log.info({ tool: "x" }, "hello");
			log.flush();
			const line = JSON.parse(readFileSync(file, "utf8").trim());
			expect(line).toMatchObject({ msg: "hello", tool: "x", name: "sbx-mcp" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("apiCallLogger", () => {
	const ok: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response> = async () => new Response("{}", { status: 201 });

	it("debug: logs method, path, status and duration, never the query, headers or body", async () => {
		const { log, lines } = capture("debug");
		const f = apiCallLogger(ok, log);
		const req = new Request(
			"http://api.test/v1/sandboxes/sb_1/files/content?path=/secret",
			{
				method: "PUT",
				headers: { authorization: "Bearer tok" },
				body: "file body",
			},
		);
		const res = await f(req);
		expect(res.status).toBe(201);
		expect(lines).toEqual([
			expect.objectContaining({
				msg: "api call",
				method: "PUT",
				path: "/v1/sandboxes/sb_1/files/content",
				status: 201,
				durationMs: expect.any(Number),
			}),
		]);
		const all = JSON.stringify(lines);
		for (const s of ["secret", "tok", "file body"])
			expect(all).not.toContain(s);
	});

	it("a failed fetch is logged with the error name and rethrown", async () => {
		const { log, lines } = capture("debug");
		const boom = new TypeError("fetch failed");
		const f = apiCallLogger(async () => {
			throw boom;
		}, log);
		await expect(f("http://api.test/v1/me")).rejects.toBe(boom);
		expect(lines[0]).toMatchObject({
			msg: "api call failed",
			method: "GET",
			path: "/v1/me",
			error: "TypeError",
		});
	});

	it("info: logs nothing", async () => {
		const { log, lines } = capture("info");
		await apiCallLogger(ok, log)("http://api.test/v1/me");
		expect(lines).toEqual([]);
	});
});
