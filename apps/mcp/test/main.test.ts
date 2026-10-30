// Process entry of the remote MCP server: the environment (settings.ts) and
// `node src/main.ts` with its two listeners and the SIGTERM stop (S11 6.2,
// 16.3).
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, SettingsError } from "../src/settings.ts";
import { FAKE_TOKENS, type FakeApi, startFakeApi } from "./fake-api/index.ts";
import { TEST_CLIENT_INFO } from "./helpers/connect.ts";

const MAIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"main.ts",
);

describe("loadSettings", () => {
	const base = {
		SBX_MCP_API_URL: "http://api:8080/",
		SBX_MCP_PUBLIC_URL: "https://api.example.com/mcp",
	};

	it("has the defaults of spec 16.3", () => {
		expect(loadSettings(base)).toEqual({
			port: 8080,
			opsPort: 9090,
			apiUrl: "http://api:8080",
			publicUrl: "https://api.example.com/mcp",
			issuer: null,
			allowedOrigins: [],
			allowedHosts: [],
			logLevel: "info",
		});
	});

	it("reads every variable", () => {
		const s = loadSettings({
			...base,
			SBX_MCP_PORT: "18080",
			SBX_MCP_OPS_PORT: "19090",
			SBX_OIDC_ISSUER: "https://kc.example.com/realms/sbx/",
			SBX_MCP_ALLOWED_ORIGINS: "https://app.example.com, http://localhost:3000",
			SBX_MCP_ALLOWED_HOSTS: "mcp.internal:8080,mcp",
			SBX_LOG_LEVEL: "debug",
		});
		expect(s).toMatchObject({
			port: 18080,
			opsPort: 19090,
			issuer: "https://kc.example.com/realms/sbx",
			allowedOrigins: ["https://app.example.com", "http://localhost:3000"],
			allowedHosts: ["mcp.internal:8080", "mcp"],
			logLevel: "debug",
		});
	});

	it("lists every problem", () => {
		let err: unknown;
		try {
			loadSettings({
				SBX_MCP_PUBLIC_URL: "ftp://x",
				SBX_MCP_PORT: "x",
				SBX_MCP_ALLOWED_ORIGINS: "https://app.example.com/path",
				SBX_LOG_LEVEL: "loud",
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SettingsError);
		const m = (err as Error).message;
		for (const k of [
			"SBX_MCP_API_URL: required",
			"SBX_MCP_PUBLIC_URL: must be an http",
			"SBX_MCP_PORT: must be an integer",
			"SBX_MCP_ALLOWED_ORIGINS.0: must be origins",
			"SBX_LOG_LEVEL",
		]) {
			expect(m).toContain(k);
		}
	});
});

describe("node src/main.ts", () => {
	let api: FakeApi | undefined;
	let child: ChildProcess | undefined;

	afterEach(async () => {
		if (child?.exitCode === null) child.kill("SIGKILL");
		child = undefined;
		await api?.close();
		api = undefined;
	});

	async function start(env: Record<string, string>) {
		const p = spawn(process.execPath, [MAIN], {
			env: { PATH: process.env.PATH ?? "", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child = p;
		let stderr = "";
		p.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		const exited = new Promise<number | null>((resolve) =>
			p.on("exit", (code) => resolve(code)),
		);
		return { p, exited, stderr: () => stderr };
	}

	it("exits 1 with the problems of a bad environment", async () => {
		const s = await start({});
		expect(await s.exited).toBe(1);
		expect(s.stderr()).toContain("SBX_MCP_API_URL: required");
	});

	it("serves both listeners and stops on SIGTERM within 10 s, a call in flight cut", async () => {
		api = await startFakeApi();
		const s = await start({
			SBX_MCP_PORT: "0",
			SBX_MCP_OPS_PORT: "0",
			SBX_MCP_API_URL: api.url,
			// Host check: the test connects to 127.0.0.1.
			SBX_MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
			SBX_MCP_ALLOWED_HOSTS: "127.0.0.1",
		});
		let ports: { port: number; opsPort: number } | undefined;
		await vi.waitFor(
			() => {
				const line = s
					.stderr()
					.split("\n")
					.find((l) => l.includes('"mcp listening"'));
				expect(line, s.stderr()).toBeDefined();
				ports = JSON.parse(line as string);
			},
			{ timeout: 20_000 },
		);
		const base = `http://127.0.0.1:${ports?.port}`;
		const ops = `http://127.0.0.1:${ports?.opsPort}`;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect((await fetch(`${ops}/readyz`)).status).toBe(200);
		const noBearer = await fetch(`${base}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(noBearer.status).toBe(401);
		expect(noBearer.headers.get("www-authenticate")).toBe(
			'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
		);

		const client = new Client(TEST_CLIENT_INFO);
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
				requestInit: {
					headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
				},
			}),
		);
		const created = await client.callTool({
			name: "sandbox_create",
			arguments: {},
		});
		const sb = JSON.parse(
			(created.content as { text: string }[])[0]?.text ?? "{}",
		).id as string;
		const call = client
			.callTool({
				name: "exec_run",
				arguments: { sandbox: sb, command: "fake:sleep 60", wait_seconds: 45 },
			})
			.catch((e: unknown) => e);
		await vi.waitFor(() => expect(api?.state.commands.size).toBe(1));
		const metrics = await (await fetch(`${ops}/metrics`)).text();
		expect(metrics).toContain("sbx_mcp_tool_calls_in_flight 1");

		const t0 = Date.now();
		s.p.kill("SIGTERM");
		expect(await s.exited).toBe(0);
		expect(Date.now() - t0).toBeLessThan(10_500);
		// The 2025-era client would reconnect forever: close it, then the
		// call settles.
		await client.close().catch(() => {});
		await call;
		expect(s.stderr()).toContain('"signal: shutting down"');
		// The command was not killed: only the wait was cut.
		expect(api.journal.filter((l) => l.endsWith("/kill"))).toEqual([]);
	}, 60_000);
});
