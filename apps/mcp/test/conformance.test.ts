// Official MCP conformance suite (S11 14.3) against createHttpApp with the
// fake API and an injected principal (the bearer flow is covered by
// http-auth.test.ts). Scenarios that need features this server does not
// have are listed with their reason in conformance-baseline.yml; the CLI
// fails on unexpected failures and on stale baseline entries alike.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { FAKE_TOKENS, FULL_SCOPES } from "./fake-api/index.ts";
import { freePort, type HttpHarness, startHttp } from "./helpers/http.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(
	here,
	"..",
	"node_modules",
	"@modelcontextprotocol",
	"conformance",
	"dist",
	"index.js",
);
const BASELINE = join(here, "conformance-baseline.yml");

let h: HttpHarness | undefined;
let results: string | undefined;

afterEach(async () => {
	await h?.close();
	h = undefined;
	if (results !== undefined)
		await rm(results, { recursive: true, force: true });
	results = undefined;
});

function run(args: string[], cwd: string) {
	return new Promise<{ code: number | null; out: string }>(
		(resolve, reject) => {
			const child = spawn(process.execPath, [CLI, ...args], {
				cwd,
				env: { ...process.env, NO_COLOR: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (d: Buffer) => {
				out += d.toString();
			});
			child.stderr.on("data", (d: Buffer) => {
				out += d.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ code, out }));
		},
	);
}

it("passes the conformance server scenarios except the baseline", async () => {
	if (!existsSync(CLI)) {
		throw new Error(
			`conformance CLI not found at ${CLI}: run \`pnpm install\` (devDependency @modelcontextprotocol/conformance)`,
		);
	}
	// dns-rebinding-protection sends Origin = the server's own origin and
	// expects it accepted: the default allowlist is empty (browsers are not
	// MCP clients, S11 6.2), so the run lists it, as a deployment that serves
	// a browser client would.
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	h = await startHttp({
		port,
		http: {
			allowedOrigins: [origin],
			authenticate: async () => ({
				token: FAKE_TOKENS.owner,
				kind: "session",
				scopes: [...FULL_SCOPES],
				expiresAt: null,
				subject: "session:conformance",
			}),
		},
	});
	results = await mkdtemp(join(tmpdir(), "umiak-mcp-conformance-"));
	const r = await run(
		["server", "--url", h.url, "--expected-failures", BASELINE],
		results,
	);
	expect(r.code, r.out).toBe(0);
	// The suite really ran against the server.
	for (const ok of [
		"server-initialize",
		"ping",
		"tools-list",
		"dns-rebinding-protection",
	]) {
		expect(r.out).toMatch(new RegExp(`✓ ${ok}: [1-9]\\d* passed, 0 failed`));
	}
}, 300_000);
