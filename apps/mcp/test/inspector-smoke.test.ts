// Inspector smoke test (S11 14.3): `inspector --cli` runs `umiak mcp` (the real
// CLI under Bun) over stdio against the fake API. The Inspector's own build
// script stays disabled (pnpm-workspace.yaml allowBuilds): the published
// package ships the built CLI, and its postinstall only installs clients of
// a source checkout.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { FAKE_TOKENS, type FakeApi, startFakeApi } from "./fake-api/index.ts";

const CLI_MAIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"cli",
	"src",
	"main.ts",
);
const BUN = process.env.UMIAK_TEST_BUN ?? "bun";

function launcher(): string {
	const require = createRequire(import.meta.url);
	const pkg = require.resolve("@modelcontextprotocol/inspector/package.json");
	return join(dirname(pkg), "clients", "launcher", "build", "index.js");
}

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

describe("inspector --cli against umiak mcp", () => {
	let api: FakeApi;
	let dir: string;

	beforeAll(async () => {
		api = await startFakeApi();
		dir = mkdtempSync(join(tmpdir(), "umiak-inspector-"));
	});
	afterAll(async () => {
		await api?.close();
		expect(api?.contractErrors).toEqual([]);
		rmSync(dir, { recursive: true, force: true });
	});

	function inspect(args: string[]): Promise<Run> {
		// A hermetic home for the CLI: no profile, the file credential store.
		const env = {
			UMIAK_API_URL: api.url,
			UMIAK_API_KEY: FAKE_TOKENS.owner,
			HOME: dir,
			XDG_CONFIG_HOME: join(dir, "config"),
			XDG_STATE_HOME: join(dir, "state"),
			UMIAK_SYSTEM_CONFIG: join(dir, "system-config.json"),
			UMIAK_CREDENTIAL_STORE: "file",
		};
		const argv = [
			launcher(),
			"--cli",
			...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
			...args,
			BUN,
			CLI_MAIN,
			"mcp",
		];
		return new Promise((resolve, reject) => {
			const child = spawn(process.execPath, argv, {
				// HOME: the Inspector keeps its own files there.
				env: { ...process.env, HOME: dir },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (s: string) => {
				stdout += s;
			});
			child.stderr.setEncoding("utf8").on("data", (s: string) => {
				stderr += s;
			});
			child.on("error", reject);
			child.on("close", (code) =>
				resolve({ code: code ?? -1, stdout, stderr }),
			);
		});
	}

	it("tools/list: exit 0 and all 39 tools", async () => {
		const r = await inspect(["--method", "tools/list"]);
		expect(r.code, r.stderr).toBe(0);
		const names = (JSON.parse(r.stdout).tools as { name: string }[]).map(
			(t) => t.name,
		);
		expect(names).toEqual(ALL_TOOLS.map((t) => t.name));
		expect(names).toHaveLength(39);
	});

	it("tools/call limits_get: exit 0 and a result that is not an error", async () => {
		const r = await inspect([
			"--method",
			"tools/call",
			"--tool-name",
			"limits_get",
		]);
		expect(r.code, r.stderr).toBe(0);
		const result = JSON.parse(r.stdout) as {
			isError?: boolean;
			content: { type: string; text: string }[];
		};
		expect(result.isError ?? false).toBe(false);
		expect(result.content[0]?.text).toContain("quota");
	});
});
