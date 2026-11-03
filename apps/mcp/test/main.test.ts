// Process entry of the remote MCP server: the environment (settings.ts) and
// `node src/main.ts` with its two listeners and the SIGTERM stop (S11 6.2,
// 16.3).
import { type ChildProcess, spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.ts";
import { type RunningMcp, SHUTDOWN_GRACE_MS, startMcp } from "../src/main.ts";
import { loadSettings, type Settings, SettingsError } from "../src/settings.ts";
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
		UMIAK_MCP_API_URL: "http://api:8080/",
		UMIAK_MCP_PUBLIC_URL: "https://api.example.com/mcp",
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

	it("retains validated canonical API URL for local internal transports", () => {
		const settings = loadSettings({
			...base,
			UMIAK_AUTH_MODE: "none",
			UMIAK_API_URL: "http://localhost:4180",
		});
		expect(settings.localEnv?.UMIAK_API_URL).toBe("http://localhost:4180");
		expect(() =>
			loadSettings({
				...base,
				UMIAK_AUTH_MODE: "none",
				UMIAK_API_URL: "invalid",
			}),
		).toThrow(SettingsError);
	});

	it("reads every variable", () => {
		const s = loadSettings({
			...base,
			UMIAK_MCP_PORT: "18080",
			UMIAK_MCP_OPS_PORT: "19090",
			UMIAK_OIDC_ISSUER: "https://kc.example.com/realms/umiak/",
			UMIAK_MCP_ALLOWED_ORIGINS:
				"https://app.example.com, http://localhost:3000",
			UMIAK_MCP_ALLOWED_HOSTS: "mcp.internal:8080,mcp",
			UMIAK_LOG_LEVEL: "debug",
		});
		expect(s).toMatchObject({
			port: 18080,
			opsPort: 19090,
			issuer: "https://kc.example.com/realms/umiak",
			allowedOrigins: ["https://app.example.com", "http://localhost:3000"],
			allowedHosts: ["mcp.internal:8080", "mcp"],
			logLevel: "debug",
		});
	});

	it("lists every problem", () => {
		let err: unknown;
		try {
			loadSettings({
				UMIAK_MCP_PUBLIC_URL: "ftp://x",
				UMIAK_MCP_PORT: "x",
				UMIAK_MCP_ALLOWED_ORIGINS: "https://app.example.com/path",
				UMIAK_LOG_LEVEL: "loud",
			});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SettingsError);
		const m = (err as Error).message;
		for (const k of [
			"UMIAK_MCP_API_URL: required",
			"UMIAK_MCP_PUBLIC_URL: must be an http",
			"UMIAK_MCP_PORT: must be an integer",
			"UMIAK_MCP_ALLOWED_ORIGINS.0: must be origins",
			"UMIAK_LOG_LEVEL",
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
		expect(s.stderr()).toContain("UMIAK_MCP_API_URL: required");
	});

	it("serves both listeners and stops on SIGTERM once the call in flight ends", async () => {
		api = await startFakeApi();
		const s = await start({
			UMIAK_MCP_PORT: "0",
			UMIAK_MCP_OPS_PORT: "0",
			UMIAK_MCP_API_URL: api.url,
			// Host check: the test connects to 127.0.0.1.
			UMIAK_MCP_PUBLIC_URL: "http://127.0.0.1/mcp",
			UMIAK_MCP_ALLOWED_HOSTS: "127.0.0.1",
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
		const call = client.callTool({
			name: "exec_run",
			arguments: { sandbox: sb, command: "fake:sleep 60", wait_seconds: 3 },
		});
		await vi.waitFor(() => expect(api?.state.commands.size).toBe(1));
		const metrics = await (await fetch(`${ops}/metrics`)).text();
		expect(metrics).toContain("umiak_mcp_tool_calls_in_flight 1");

		const t0 = Date.now();
		s.p.kill("SIGTERM");
		// The call in flight gets its answer: the wait ends, the command runs on.
		const r = await call;
		expect(r.isError).toBeFalsy();
		expect((r.content as { text: string }[])[0]?.text).toContain(
			'"status":"running"',
		);
		expect(await s.exited).toBe(0);
		expect(Date.now() - t0).toBeLessThan(SHUTDOWN_GRACE_MS);
		await client.close().catch(() => {});
		expect(s.stderr()).toContain('"signal: shutting down"');
		// The command was not killed: only the wait was cut.
		expect(api.journal.filter((l) => l.endsWith("/kill"))).toEqual([]);
	}, 60_000);
});

describe("startMcp", () => {
	let api: FakeApi | undefined;
	let running: RunningMcp | undefined;

	afterEach(async () => {
		await running?.close();
		running = undefined;
		await api?.close();
		api = undefined;
	});

	function settings(apiUrl: string): Settings {
		return {
			port: 0,
			opsPort: 0,
			apiUrl,
			publicUrl: "http://127.0.0.1/mcp",
			issuer: null,
			allowedOrigins: [],
			allowedHosts: ["127.0.0.1"],
			logLevel: "info",
		};
	}

	const quiet = () => createLogger({ level: "silent" });

	it("has a 25 s grace: above the 50 s budget's tail, under compose's 30 s stop_grace_period", () => {
		expect(SHUTDOWN_GRACE_MS).toBe(25_000);
	});

	it("closes a request whose body does not arrive in time (408)", async () => {
		api = await startFakeApi();
		running = await startMcp(settings(api.url), {
			log: quiet(),
			requestTimeoutMs: 1_000,
			headersTimeoutMs: 500,
		});
		const port = running.port;
		const t0 = Date.now();
		const answer = await new Promise<string>((resolve, reject) => {
			const sock = connect(port, "127.0.0.1", () => {
				sock.write(
					[
						"POST /mcp HTTP/1.1",
						"Host: 127.0.0.1",
						`Authorization: Bearer ${FAKE_TOKENS.full}`,
						"Content-Type: application/json",
						"Content-Length: 1000",
						"",
						'{"jsonrpc":',
					].join("\r\n"),
				);
			});
			let got = "";
			sock.on("data", (d: Buffer) => {
				got += d.toString();
			});
			sock.on("close", () => resolve(got));
			sock.on("error", reject);
			sock.setTimeout(8_000, () => {
				sock.destroy();
				reject(new Error("the server kept the slow request open"));
			});
		});
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(answer).toMatch(/^HTTP\/1\.1 408/);
	}, 15_000);

	it("drains the main port at once: /readyz and a new POST /mcp are 503 while a call is in flight", async () => {
		api = await startFakeApi();
		const r = await startMcp(settings(api.url), {
			log: quiet(),
			graceMs: 10_000,
		});
		running = r;
		const client = new Client(TEST_CLIENT_INFO);
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${r.port}/mcp`),
				{
					requestInit: {
						headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
					},
				},
			),
		);
		const created = await client.callTool({
			name: "sandbox_create",
			arguments: {},
		});
		const sb = JSON.parse(
			(created.content as { text: string }[])[0]?.text ?? "{}",
		).id as string;
		const call = client.callTool({
			name: "exec_run",
			arguments: { sandbox: sb, command: "fake:sleep 60", wait_seconds: 3 },
		});
		await vi.waitFor(() => expect(api?.state.commands.size).toBe(1));

		// A closing server takes no new connection and closes idle ones: the
		// requests start on open connections before close() and end after it.
		// Each connection first answers GET /healthz (it is accepted and kept
		// alive), then gets the start of its next request; one check phase
		// later the server has read it (a poll phase runs in between), so the
		// connection counts as busy, not idle.
		const startedOn = async (head: string) => {
			const sock = connect(r.port, "127.0.0.1");
			let got = "";
			sock.on("data", (d: Buffer) => {
				got += d.toString();
			});
			const done = new Promise<string>((resolve) => {
				sock.on("close", () => resolve(got));
				sock.on("error", () => resolve(got));
			});
			sock.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
			await vi.waitFor(() => expect(got).toContain('{"ok":true}'));
			got = "";
			sock.write(head);
			return { sock, done };
		};
		const ready = await startedOn(
			"GET /readyz HTTP/1.1\r\nHost: 127.0.0.1\r\n",
		);
		const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}';
		const post = await startedOn(
			[
				"POST /mcp HTTP/1.1",
				"Host: 127.0.0.1",
				`Authorization: Bearer ${FAKE_TOKENS.full}`,
				"Content-Type: application/json",
				"Accept: application/json, text/event-stream",
				`Content-Length: ${body.length}`,
				"",
			].join("\r\n"),
		);
		await new Promise((res) => setImmediate(res));
		const closing = r.close();
		running = undefined;
		// Several sweeps of idle connections (every 50 ms) pass first.
		await new Promise((res) => setTimeout(res, 200));
		// No half-close: Connection: close makes the server end the socket.
		ready.sock.write("Connection: close\r\n\r\n");
		post.sock.write(`Connection: close\r\n\r\n${body}`);
		const readyAnswer = await ready.done;
		expect(readyAnswer).toMatch(/^HTTP\/1\.1 503/);
		expect(readyAnswer).toContain("shutting_down");
		const postAnswer = await post.done;
		expect(postAnswer).toMatch(/^HTTP\/1\.1 503/);
		expect(postAnswer.toLowerCase()).toContain("retry-after: 1");

		// The call in flight still gets its answer.
		const result = await call;
		expect(result.isError).toBeFalsy();
		await closing;
		await client.close().catch(() => {});
	}, 20_000);

	it("cuts a call still running when the grace period ends", async () => {
		api = await startFakeApi();
		const r = await startMcp(settings(api.url), {
			log: quiet(),
			graceMs: 1_500,
		});
		const client = new Client(TEST_CLIENT_INFO);
		await client.connect(
			new StreamableHTTPClientTransport(
				new URL(`http://127.0.0.1:${r.port}/mcp`),
				{
					requestInit: {
						headers: { Authorization: `Bearer ${FAKE_TOKENS.full}` },
					},
				},
			),
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
		const t0 = Date.now();
		await r.close();
		expect(Date.now() - t0).toBeLessThan(3_000);
		await client.close().catch(() => {});
		await call;
	}, 20_000);
});
