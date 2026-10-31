// Spike (spec 12.2): the MCP server SDK bundles into a `bun build --compile`
// single binary and the binary speaks MCP over stdio.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "spike-server.ts");
const appDir = join(here, "..");

const OFFLINE_ERROR =
	/failed to download|download failed|getaddrinfo|ConnectionRefused|FailedToOpenSocket|network is unreachable|Unable to connect/i;

let outDir: string;

beforeAll(() => {
	outDir = mkdtempSync(join(tmpdir(), "sbx-mcp-spike-"));
});

afterAll(() => {
	rmSync(outDir, { recursive: true, force: true });
});

function compile(outfile: string, target?: string) {
	const args = ["build", "--compile", fixture, "--outfile", outfile];
	if (target) args.push(`--target=${target}`);
	return spawnSync("bun", args, { cwd: appDir, encoding: "utf8" });
}

describe("bun compile spike", () => {
	it("compiled binary serves tools/list and tools/call over stdio", async () => {
		const outfile = join(outDir, "spike-host");
		const built = compile(outfile);
		expect(built.status, built.stderr).toBe(0);
		expect(statSync(outfile).size).toBeGreaterThan(0);

		const transport = new StdioClientTransport({ command: outfile });
		const client = new Client({ name: "spike-client", version: "0.0.0" });
		try {
			await client.connect(transport);
			const listed = await client.listTools();
			expect(listed.tools.map((t) => t.name)).toContain("ping");
			const called = await client.callTool({ name: "ping", arguments: {} });
			expect(called.content).toEqual([{ type: "text", text: "pong" }]);
		} finally {
			await client.close();
		}
	});

	it("cross-compiles for bun-linux-x64", (ctx) => {
		const outfile = join(outDir, "spike-linux-x64");
		const built = compile(outfile, "bun-linux-x64");
		// The cross target runtime is downloaded on first use; without network
		// the build cannot run, which says nothing about SDK bundling.
		if (built.status !== 0 && OFFLINE_ERROR.test(built.stderr)) {
			ctx.skip(
				`cross-target runtime not downloadable: ${built.stderr.trim().slice(0, 200)}`,
			);
		}
		expect(built.status, built.stderr).toBe(0);
	});
});
