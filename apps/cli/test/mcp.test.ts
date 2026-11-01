// `umiak mcp` (S11 §6.1, §8.8, §10.2): the real CLI as a child process,
// talked to over its stdio with a bare JSON-RPC peer. Every byte of its
// stdout must be JSON-RPC. Against the MCP fake API (apps/mcp/test/fake-api)
// for the list, filters, pinning and cancellation; against the CLI test world
// (api + test OIDC) for the token refresh of parallel calls.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateApiKeySecret } from "@umiak/auth/api-key";
import { UmiakError } from "@umiak/sdk";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { MCP_VERSION } from "../../mcp/src/version.ts";
import {
	FAKE_TEAM,
	FAKE_TOKENS,
	type FakeApi,
	FULL_SCOPES,
	startFakeApi,
} from "../../mcp/test/fake-api/index.ts";
import {
	type Json,
	type RpcLines,
	rpcLines,
	toolAnswer,
} from "../../mcp/test/helpers/rpc-lines.ts";
import type { Bearer } from "../src/auth/token.ts";
import { mcpCredentials } from "../src/commands/mcp-auth.ts";
import { CLI_VERSION } from "../src/commands/version.ts";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function jwtClaims(token: string): Record<string, unknown> {
	return JSON.parse(
		Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
	);
}
const BUN = process.env.UMIAK_TEST_BUN ?? "bun";

interface McpChild {
	child: ChildProcess;
	rpc: RpcLines;
	stdout(): string;
	stderr(): string;
	/** Exit code once the process ended. */
	exited: Promise<number>;
	/** Closes stdin; resolves with the exit code. */
	close(): Promise<number>;
}

const children: ChildProcess[] = [];
const homes: CliHome[] = [];

afterEach(() => {
	for (const c of children.splice(0)) {
		if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
	}
	for (const h of homes.splice(0)) h.rm();
});

function home(): CliHome {
	const h = cliHome();
	homes.push(h);
	return h;
}

function startMcp(args: string[], env: Record<string, string>): McpChild {
	const child = spawn(BUN, [join(CLI_DIR, "src/main.ts"), "mcp", ...args], {
		cwd: CLI_DIR,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	const rpc = rpcLines((line) => child.stdin.write(line));
	let out = "";
	let err = "";
	child.stdout.on("data", (b: Buffer) => {
		out += b.toString();
		rpc.feed(b);
	});
	child.stderr.setEncoding("utf8").on("data", (s: string) => {
		err += s;
	});
	child.stdin.on("error", () => {});
	const exited = new Promise<number>((resolve) => {
		child.on("close", (code) => {
			rpc.fail(new Error(`umiak mcp exited with ${code}; stderr: ${err}`));
			resolve(code ?? -1);
		});
	});
	return {
		child,
		rpc,
		stdout: () => out,
		stderr: () => err,
		exited,
		close() {
			child.stdin.end();
			return exited;
		},
	};
}

async function toolNames(rpc: RpcLines): Promise<string[]> {
	const r = await rpc.request("tools/list");
	return ((r.result as Json).tools as Json[]).map((t) => t.name as string);
}

/** Every stdout line is a JSON-RPC 2.0 message. */
function expectOnlyJsonRpc(m: McpChild): void {
	expect(m.rpc.garbage).toEqual([]);
	for (const line of m.stdout().split("\n")) {
		if (line === "") continue;
		expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
	}
}

describe("umiak mcp against the fake API", () => {
	let api: FakeApi;
	/** A well-formed team key (umiak login --key-stdin checks the format). */
	const loginKey = generateApiKeySecret();

	beforeAll(async () => {
		api = await startFakeApi({
			tokens: {
				[loginKey]: {
					kind: "team_key",
					scopes: FULL_SCOPES,
					teamId: FAKE_TEAM,
				},
			},
		});
	});
	afterAll(async () => {
		await api?.close();
		expect(api?.contractErrors).toEqual([]);
	});

	const keyEnv = (h: CliHome, key: string = FAKE_TOKENS.full) => ({
		...h.env,
		UMIAK_API_URL: api.url,
		UMIAK_API_KEY: key,
	});

	async function readySandbox(rpc: RpcLines): Promise<string> {
		const r = await rpc.callTool("sandbox_create", {});
		expect(r.isError, r.text).toBe(false);
		return JSON.parse(r.text.split("\n")[0] ?? "").id as string;
	}

	const kills = () => api.journal.filter((l) => l.endsWith("/kill"));

	it("without a login: tools/list works and a call says to run umiak login; after the login the next call works", async () => {
		const h = home();
		const m = startMcp([], h.env);
		await m.rpc.initialize();
		expect(await toolNames(m.rpc)).toHaveLength(38);
		const r = await m.rpc.callTool("limits_get");
		expect(r.isError).toBe(true);
		expect(r.text).toContain("error: not_logged_in");
		expect(r.text).toContain("run `umiak login` in a terminal");
		// The person logs in from a terminal; the server reads the config again.
		const login = await runCli(["login", "--key-stdin", "--api-url", api.url], {
			env: h.env,
			stdin: `${loginKey}\n`,
		});
		expect(login.code, login.stderr).toBe(0);
		const again = await m.rpc.callTool("limits_get");
		expect(again.isError, again.text).toBe(false);
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	});

	it("a read-only key sees only read-only tools", async () => {
		const h = home();
		const m = startMcp([], keyEnv(h, FAKE_TOKENS.readOnly));
		await m.rpc.initialize();
		const r = await m.rpc.request("tools/list");
		const tools = (r.result as Json).tools as Json[];
		expect(tools.length).toBeGreaterThan(0);
		expect(tools.length).toBeLessThan(38);
		for (const t of tools) {
			expect((t.annotations as Json).readOnlyHint, String(t.name)).toBe(true);
		}
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	});

	it("--sandbox self without UMIAK_SANDBOX_ID: exit 2, the reason on stderr, nothing on stdout", async () => {
		const h = home();
		const r = await runCli(["mcp", "--sandbox", "self"], {
			env: keyEnv(h),
		});
		expect(r.code).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("UMIAK_SANDBOX_ID is not set");
	});

	it("--sandbox sb_x: schemas have no sandbox argument, the instructions name it", async () => {
		const h = home();
		const m = startMcp(["--sandbox", "sb_x"], keyEnv(h));
		const init = await m.rpc.initialize();
		expect(init.instructions).toContain("bound to sandbox sb_x");
		const r = await m.rpc.request("tools/list");
		const tools = (r.result as Json).tools as Json[];
		expect(tools.map((t) => t.name)).not.toContain("sandbox_create");
		for (const t of tools) {
			const schema = t.inputSchema as { properties?: Json };
			expect(schema.properties ?? {}).not.toHaveProperty("sandbox");
		}
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	});

	it("--sandbox self inside a sandbox binds to the sb_ id of UMIAK_SANDBOX_ID", async () => {
		const h = home();
		const m = startMcp(["--sandbox", "self"], {
			...keyEnv(h),
			UMIAK_SANDBOX_ID: "00000000-0000-4000-8000-000000000001",
		});
		const init = await m.rpc.initialize();
		expect(init.instructions).toMatch(/bound to sandbox sb_[0-9a-z]+:/);
		expect(await m.close()).toBe(0);
	});

	it("bad --toolsets and --log-level are usage errors (exit 2) before serving", async () => {
		const h = home();
		const bad = await runCli(["mcp", "--toolsets", "core,shell"], {
			env: keyEnv(h),
		});
		expect(bad.code).toBe(2);
		expect(bad.stdout).toBe("");
		expect(bad.stderr).toContain(
			"valid: core, files, ports, snapshots, desktop",
		);
		const level = await runCli(["mcp", "--log-level", "loud"], {
			env: keyEnv(h),
		});
		expect(level.code).toBe(2);
		expect(level.stdout).toBe("");
	});

	it("UMIAK_MCP_TOOLSETS and UMIAK_MCP_READ_ONLY=1 narrow the list", async () => {
		const h = home();
		const m = startMcp([], {
			...keyEnv(h),
			UMIAK_MCP_TOOLSETS: "files",
			UMIAK_MCP_READ_ONLY: "1",
		});
		await m.rpc.initialize();
		expect(await toolNames(m.rpc)).toEqual([
			"files_read",
			"files_list",
			"files_stat",
		]);
		expect(await m.close()).toBe(0);
	});

	it("notifications/cancelled over real stdio kills exec_run's command; closing stdin exits 0", async () => {
		const h = home();
		const m = startMcp([], keyEnv(h));
		await m.rpc.initialize();
		const sb = await readySandbox(m.rpc);
		const before = kills().length;
		const call = m.rpc.start("tools/call", {
			name: "exec_run",
			arguments: { sandbox: sb, command: "fake:sleep 30" },
		});
		await vi.waitFor(
			() =>
				expect(
					[...api.state.commands.values()].some(
						(c) => c.sandboxId === sb && c.status === "running",
					),
				).toBe(true),
			{ timeout: 15_000 },
		);
		await new Promise((r) => setTimeout(r, 300));
		m.rpc.notify("notifications/cancelled", {
			requestId: call.id,
			reason: "Esc",
		});
		await vi.waitFor(() => expect(kills().length).toBe(before + 1), {
			timeout: 15_000,
		});
		expect(await m.close()).toBe(0);
		expect(m.rpc.messages.some((x) => x.id === call.id)).toBe(false);
		expectOnlyJsonRpc(m);
	});

	it("closing stdin in the middle of exec_run exits 0 and leaves the command running", async () => {
		const h = home();
		const m = startMcp([], keyEnv(h));
		await m.rpc.initialize();
		const sb = await readySandbox(m.rpc);
		const before = kills().length;
		m.rpc.start("tools/call", {
			name: "exec_run",
			arguments: { sandbox: sb, command: "fake:sleep 30" },
		});
		let command: string | undefined;
		await vi.waitFor(
			() => {
				command = [...api.state.commands.values()].find(
					(c) => c.sandboxId === sb && c.status === "running",
				)?.id;
				expect(command).toBeDefined();
			},
			{ timeout: 15_000 },
		);
		await new Promise((r) => setTimeout(r, 300));
		expect(await m.close()).toBe(0);
		await new Promise((r) => setTimeout(r, 300));
		expect(kills().length).toBe(before);
		expect(api.state.commands.get(command as string)?.status).toBe("running");
		expectOnlyJsonRpc(m);
	});

	it("umiak --json mcp: usage errors still go to stderr, never to stdout", async () => {
		const h = home();
		for (const args of [
			["--json", "mcp", "--toolsets", "core,shell"],
			["--json", "mcp", "--no-such-flag"],
			["--json", "mcp", "--sandbox", "self"],
		]) {
			const r = await runCli(args, { env: keyEnv(h) });
			expect(r.code, args.join(" ")).toBe(2);
			expect(r.stdout, args.join(" ")).toBe("");
			expect(r.stderr, args.join(" ")).toContain('"code":"usage"');
		}
	});

	it("a stored key the API stops accepting (401): the next call after a new umiak login works without a restart", async () => {
		const h = home();
		const first = generateApiKeySecret();
		const second = generateApiKeySecret();
		const principal = {
			kind: "team_key" as const,
			scopes: FULL_SCOPES,
			teamId: FAKE_TEAM,
		};
		api.tokens.set(first, principal);
		const login = (key: string) =>
			runCli(["login", "--key-stdin", "--api-url", api.url], {
				env: h.env,
				stdin: `${key}\n`,
			});
		expect((await login(first)).code).toBe(0);
		const m = startMcp([], h.env);
		await m.rpc.initialize();
		expect((await m.rpc.callTool("limits_get")).isError).toBe(false);
		// The key is revoked: the api answers 401 unauthorized.
		api.tokens.delete(first);
		const rejected = await m.rpc.callTool("limits_get");
		expect(rejected.isError).toBe(true);
		expect(rejected.text).toContain("error: unauthorized");
		expect(rejected.text).toContain("run `umiak login` in a terminal");
		expect(rejected.text).toContain("retryable: false");
		api.tokens.set(second, principal);
		expect((await login(second)).code).toBe(0);
		const again = await m.rpc.callTool("limits_get");
		expect(again.isError, again.text).toBe(false);
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	});

	it("UMIAK_API_KEY the API rejects: the hint says to fix it and restart the server", async () => {
		const h = home();
		const m = startMcp([], keyEnv(h, generateApiKeySecret()));
		await m.rpc.initialize();
		const r = await m.rpc.callTool("limits_get");
		expect(r.isError).toBe(true);
		expect(r.text).toContain("error: unauthorized");
		expect(r.text).toContain("fix UMIAK_API_KEY");
		expect(r.text).toContain("restart the MCP server");
		expect(r.text).not.toContain("umiak login");
		expect(await m.close()).toBe(0);
	});

	it("not logged in to this API: the error keeps the CLI's reason and the umiak login hint", async () => {
		const h = home();
		const login = await runCli(["login", "--key-stdin", "--api-url", api.url], {
			env: h.env,
			stdin: `${loginKey}\n`,
		});
		expect(login.code).toBe(0);
		const m = startMcp([], { ...h.env, UMIAK_API_URL: "http://127.0.0.1:9" });
		await m.rpc.initialize();
		const r = await m.rpc.callTool("limits_get");
		expect(r.text).toContain("error: not_logged_in");
		expect(r.text).toContain(
			`is logged in to ${api.url}, not http://127.0.0.1:9`,
		);
		expect(r.text).toContain("hint: run `umiak login` in a terminal");
		expect(await m.close()).toBe(0);
	});

	it("--log-level debug writes API calls (no secrets) to stderr; --log-file takes the logs instead", async () => {
		const h = home();
		const m = startMcp(["--log-level", "debug"], keyEnv(h));
		await m.rpc.initialize();
		await m.rpc.callTool("limits_get");
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
		const lines = m
			.stderr()
			.split("\n")
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l) as Json);
		expect(lines).toContainEqual(
			expect.objectContaining({
				msg: "api call",
				method: "GET",
				path: "/v1/limits",
				status: 200,
			}),
		);
		expect(m.stderr()).not.toContain(FAKE_TOKENS.full);

		const file = join(h.dir, "logs", "mcp.log");
		const f = startMcp(["--log-file", file], keyEnv(h));
		await f.rpc.initialize();
		await f.rpc.callTool("limits_get");
		expect(await f.close()).toBe(0);
		expect(f.stderr()).toBe("");
		expect(readFileSync(file, "utf8")).toContain('"msg":"tool call"');
	});
});

describe("versions", () => {
	it("the MCP server reports the CLI version", () => {
		expect(MCP_VERSION).toBe(CLI_VERSION);
	});
});

describe("mcpCredentials", () => {
	const okFetch = async () => new Response("{}", { status: 200 });

	function source(tokens: string[]) {
		const calls: boolean[] = [];
		const bearer = async (force: boolean): Promise<Bearer> => {
			calls.push(force);
			await new Promise((r) => setTimeout(r, 20));
			const token = tokens[Math.min(calls.length - 1, tokens.length - 1)];
			return { kind: "oidc", token: token as string, expiresAt: null };
		};
		return { calls, bearer };
	}

	it("parallel calls share one bearer lookup", async () => {
		const s = source(["t1"]);
		const c = mcpCredentials(s.bearer, okFetch);
		const got = await Promise.all([
			c.tokenProvider({ force: false }),
			c.tokenProvider({ force: false }),
			c.tokenProvider({ force: false }),
		]);
		expect(got).toEqual(["t1", "t1", "t1"]);
		expect(s.calls).toEqual([false]);
	});

	it("parallel 401s to the same token make one forced refresh", async () => {
		const s = source(["old", "new"]);
		const unauthorized = async () => new Response("{}", { status: 401 });
		const c = mcpCredentials(s.bearer, unauthorized);
		const token = await c.tokenProvider({ force: false });
		const req = () =>
			new Request("http://api.test/v1/me", {
				headers: { authorization: `Bearer ${token}` },
			});
		await Promise.all([c.fetch(req()), c.fetch(req())]);
		const forced = await Promise.all([
			c.tokenProvider({ force: true }),
			c.tokenProvider({ force: true }),
		]);
		expect(forced).toEqual(["new", "new"]);
		// A late 401 for the old token does not force another refresh.
		await c.fetch(req());
		expect(await c.tokenProvider({ force: true })).toBe("new");
		expect(s.calls).toEqual([false, true]);
	});

	it("a forced call refreshes when the current token was rejected", async () => {
		const s = source(["a", "b", "c"]);
		const c = mcpCredentials(
			s.bearer,
			async () => new Response("", { status: 401 }),
		);
		await c.tokenProvider({ force: false });
		await c.fetch(
			new Request("http://api.test/", {
				headers: { authorization: "Bearer a" },
			}),
		);
		expect(await c.tokenProvider({ force: true })).toBe("b");
		await c.fetch(
			new Request("http://api.test/", {
				headers: { authorization: "Bearer b" },
			}),
		);
		expect(await c.tokenProvider({ force: true })).toBe("c");
		expect(s.calls).toEqual([false, true, true]);
	});

	it("a failed lookup is not cached", async () => {
		let fail = true;
		const c = mcpCredentials(async () => {
			if (fail) {
				throw new UmiakError({
					status: 0,
					code: "not_logged_in",
					message: "no",
					retryable: false,
				});
			}
			return { kind: "key", token: "k", expiresAt: null };
		}, okFetch);
		await expect(c.tokenProvider({ force: false })).rejects.toThrow("no");
		fail = false;
		expect(await c.tokenProvider({ force: false })).toBe("k");
	});
});

describe("umiak mcp with a Keycloak login", () => {
	let w: CliWorld;
	beforeAll(async () => {
		// Fresh for 2 s only (the CLI refreshes 90 s before expiry).
		w = await startWorld({ oidc: { deviceInterval: 0, accessTokenTtl: 92 } });
	});
	afterAll(async () => {
		await w?.close();
	});

	async function loggedIn() {
		const h = home();
		const sub = `kc-${crypto.randomUUID()}`;
		const claims = { sub, email: `${sub}@example.com` };
		w.oidc.deviceFlow.autoApprove(claims);
		const login = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: h.env,
		});
		expect(login.code, login.stderr).toBe(0);
		const credFile = join(h.configDir, "credentials.json");
		const entry = `default@${w.oidc.issuer}`;
		const stored = () =>
			JSON.parse(JSON.parse(readFileSync(credFile, "utf8"))[entry]) as {
				accessToken: string;
				expiresAt: string;
			};
		const store = (accessToken: string, expiresAt: string) => {
			const all = JSON.parse(readFileSync(credFile, "utf8"));
			all[entry] = JSON.stringify({ ...stored(), accessToken, expiresAt });
			writeFileSync(credFile, JSON.stringify(all), { mode: 0o600 });
		};
		return { h, claims, stored, store };
	}

	async function twoParallelCalls(m: McpChild): Promise<void> {
		const [a, b] = await Promise.all([
			m.rpc.request("tools/call", { name: "templates_list", arguments: {} }),
			m.rpc.request("tools/call", { name: "templates_list", arguments: {} }),
		]);
		const ra = toolAnswer(a);
		const rb = toolAnswer(b);
		expect(ra.isError, ra.text).toBe(false);
		expect(rb.isError, rb.text).toBe(false);
	}

	it("two parallel calls with an access token due for refresh make exactly one refresh and both succeed", async () => {
		const { h, stored } = await loggedIn();
		const m = startMcp([], h.env);
		await m.rpc.initialize();
		expect(await toolNames(m.rpc)).toHaveLength(38);
		// Wait until the newest stored access token is due for a refresh.
		const due = Date.parse(stored().expiresAt) - 90_000;
		await new Promise((r) =>
			setTimeout(r, Math.max(0, due - Date.now()) + 300),
		);
		const refreshes = w.oidc.stats.refresh;
		await twoParallelCalls(m);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	});

	it("two parallel calls rejected with 401 token_expired (token fresh by its stored expiry) make exactly one forced refresh", async () => {
		const { h, claims, store } = await loggedIn();
		// The api accepts it for about 10 s more (60 s clock tolerance); the
		// stored expiry says it is fresh for an hour, so only a 401 tells.
		const token = await w.oidc.token(claims, { expiresIn: -50 });
		store(token, new Date(Date.now() + 3_600_000).toISOString());
		const refreshes = w.oidc.stats.refresh;
		const m = startMcp([], h.env);
		await m.rpc.initialize();
		expect(await toolNames(m.rpc)).toHaveLength(38);
		// GET /v1/me at the start still went through with this token.
		expect(w.oidc.stats.refresh).toBe(refreshes);
		const exp = Number(jwtClaims(token).exp) * 1000;
		await new Promise((r) =>
			setTimeout(r, Math.max(0, exp + 60_000 - Date.now()) + 1_000),
		);
		await twoParallelCalls(m);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
		expect(await m.close()).toBe(0);
		expectOnlyJsonRpc(m);
	}, 60_000);
});
