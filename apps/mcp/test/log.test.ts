import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, REDACT_PATHS } from "../src/log.ts";

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
