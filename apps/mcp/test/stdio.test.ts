// runStdio over in-memory streams with a bare JSON-RPC peer: the list, the
// principal lookup, stdio cancellation semantics (spec 10.2) and a clean
// stdout.
import { PassThrough } from "node:stream";
import { Umiak } from "@umiak/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/errors.ts";
import { pinnedInstructions } from "../src/instructions.ts";
import { createLogger } from "../src/log.ts";
import {
	CancelTrackingTransport,
	PRINCIPAL_TIMEOUT_MS,
	runStdio,
	type StdioOptions,
	type StdioServer,
} from "../src/stdio.ts";
import { ALL_TOOLS } from "../src/tools/index.ts";
import { FAKE_TOKENS, type FakeApi, startFakeApi } from "./fake-api/index.ts";
import { type Json, type RpcLines, rpcLines } from "./helpers/rpc-lines.ts";

interface Setup {
	api: FakeApi;
	server: StdioServer;
	rpc: RpcLines;
	stdin: PassThrough;
	logs: Json[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(
	o: { token?: string } & Partial<StdioOptions> = {},
): Promise<Setup> {
	const api = await startFakeApi();
	cleanups.push(async () => {
		await api.close();
		expect(api.contractErrors).toEqual([]);
	});
	const umiak = new Umiak({
		baseUrl: api.url,
		apiKey: o.token ?? FAKE_TOKENS.oidc,
		env: {},
	});
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const logs: Json[] = [];
	const log = createLogger({
		level: "debug",
		destination: { write: (line: string) => logs.push(JSON.parse(line)) },
	});
	const { token: _token, ...rest } = o;
	const server = await runStdio({
		umiak: () => umiak,
		log,
		stdin,
		stdout,
		...rest,
	});
	cleanups.push(() => server.close());
	const rpc = rpcLines((line) => stdin.write(line));
	stdout.on("data", (chunk: Buffer) => rpc.feed(chunk));
	return { api, server, rpc, stdin, logs };
}

async function toolNames(rpc: RpcLines): Promise<string[]> {
	const r = await rpc.request("tools/list");
	return ((r.result as Json).tools as Json[]).map((t) => t.name as string);
}

async function readySandbox(rpc: RpcLines): Promise<string> {
	const r = await rpc.callTool("sandbox_create", {});
	expect(r.isError, r.text).toBe(false);
	const json = JSON.parse(r.text.split("\n")[0] ?? "");
	expect(json.state).toBe("ready");
	return json.id as string;
}

const kills = (api: FakeApi) => api.journal.filter((l) => l.endsWith("/kill"));

/** Starts exec_run of a long command and waits until its stream is open. */
async function longRun(s: Setup) {
	await s.rpc.initialize();
	const sb = await readySandbox(s.rpc);
	const call = s.rpc.start("tools/call", {
		name: "exec_run",
		arguments: { sandbox: sb, command: "fake:sleep 30" },
	});
	await vi.waitFor(() => expect(s.api.state.commands.size).toBe(1));
	// Let the stream open, so the tool knows the command id.
	await new Promise((r) => setTimeout(r, 200));
	const command = [...s.api.state.commands.values()][0]?.id as string;
	return { call, command };
}

describe("runStdio", () => {
	it("answers initialize and tools/list with all 38 tools for a person", async () => {
		const { rpc } = await setup();
		const init = await rpc.initialize();
		expect(init.serverInfo).toMatchObject({ name: "umiak" });
		expect(await toolNames(rpc)).toEqual(ALL_TOOLS.map((t) => t.name));
		expect(ALL_TOOLS).toHaveLength(38);
		expect(rpc.garbage).toEqual([]);
	});

	it("reads the principal once: a read-only key sees only read-only tools", async () => {
		const { rpc, api } = await setup({ token: FAKE_TOKENS.readOnly });
		await rpc.initialize();
		const names = await toolNames(rpc);
		const readOnly = new Set(
			ALL_TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name),
		);
		expect(names.length).toBeGreaterThan(0);
		expect(names.length).toBeLessThan(38);
		for (const n of names) expect(readOnly.has(n)).toBe(true);
		await toolNames(rpc);
		expect(api.journal.filter((l) => l === "GET /v1/me")).toHaveLength(1);
	});

	it("without a login: tools/list still lists every tool, a call answers not_logged_in", async () => {
		const { rpc, logs } = await setup({
			umiak: () => {
				throw new ToolError({
					code: "not_logged_in",
					message: "run `umiak login` in a terminal, then retry",
				});
			},
		});
		await rpc.initialize();
		expect(await toolNames(rpc)).toHaveLength(38);
		const r = await rpc.callTool("limits_get");
		expect(r.isError).toBe(true);
		expect(r.text).toContain("error: not_logged_in");
		expect(r.text).toContain("run `umiak login` in a terminal");
		expect(logs).toContainEqual(
			expect.objectContaining({
				msg: "principal unknown, listing every tool",
				code: "not_logged_in",
			}),
		);
	});

	it("a /v1/me that does not answer delays the first answer by at most 5 s, then lists every tool", async () => {
		const api = await startFakeApi();
		cleanups.push(() => api.close());
		const hanging: typeof fetch = async (input, init) => {
			const req =
				input instanceof Request && init === undefined
					? input
					: new Request(input, init);
			if (new URL(req.url).pathname === "/v1/me") {
				return new Promise((_, reject) => {
					req.signal.addEventListener("abort", () => reject(req.signal.reason));
				});
			}
			return fetch(req);
		};
		const umiak = new Umiak({
			baseUrl: api.url,
			apiKey: FAKE_TOKENS.readOnly,
			env: {},
			fetch: hanging,
		});
		const s = await setup({ umiak: () => umiak });
		const started = Date.now();
		await s.rpc.initialize();
		expect(await toolNames(s.rpc)).toHaveLength(38);
		const took = Date.now() - started;
		expect(took).toBeGreaterThanOrEqual(PRINCIPAL_TIMEOUT_MS - 200);
		expect(took).toBeLessThan(PRINCIPAL_TIMEOUT_MS + 3_000);
	}, 20_000);

	it("pinned: the pinned instructions, no sandbox argument, no hidden tools", async () => {
		const { rpc } = await setup({ pinnedSandbox: "sb_x" });
		const init = await rpc.initialize();
		expect(init.instructions).toBe(pinnedInstructions("sb_x"));
		const r = await rpc.request("tools/list");
		const tools = (r.result as Json).tools as Json[];
		const names = tools.map((t) => t.name);
		expect(names).not.toContain("sandbox_create");
		expect(names).not.toContain("sandbox_delete");
		for (const t of tools) {
			const schema = t.inputSchema as { properties?: Json };
			expect(schema.properties ?? {}).not.toHaveProperty("sandbox");
		}
	});

	it("notifications/cancelled for exec_run kills the command with graceMs 5000", async () => {
		const s = await setup();
		const { call, command } = await longRun(s);
		s.rpc.notify("notifications/cancelled", {
			requestId: call.id,
			reason: "user pressed Esc",
		});
		await vi.waitFor(() => expect(kills(s.api)).toHaveLength(1));
		expect(kills(s.api)[0]).toContain(`/commands/${command}/kill`);
		await vi.waitFor(() =>
			expect(s.api.state.commands.get(command)?.status).toBe("killed"),
		);
		// A cancelled request is not answered.
		await new Promise((r) => setTimeout(r, 100));
		expect(s.rpc.messages.some((m) => m.id === call.id)).toBe(false);
		expect(s.rpc.garbage).toEqual([]);
	});

	it("closing stdin in the middle of exec_run leaves the command running and resolves closed", async () => {
		const s = await setup();
		const { command } = await longRun(s);
		s.stdin.end();
		await s.server.closed;
		await new Promise((r) => setTimeout(r, 300));
		expect(kills(s.api)).toEqual([]);
		expect(s.api.state.commands.get(command)?.status).toBe("running");
	});

	it("writes nothing but JSON-RPC to its stdout and nothing to process.stdout", async () => {
		const spy = vi.spyOn(process.stdout, "write");
		const s = await setup();
		await s.rpc.initialize();
		await toolNames(s.rpc);
		const sb = await readySandbox(s.rpc);
		await s.rpc.callTool("exec_run", { sandbox: sb, command: "fake:sleep 0" });
		await s.rpc.callTool("files_read", { sandbox: sb, path: "/nope" });
		await s.rpc.request("no/such/method");
		s.stdin.write("this is not json\n");
		await s.rpc.request("ping");
		expect(s.rpc.garbage).toEqual([]);
		expect(s.rpc.messages.length).toBeGreaterThanOrEqual(7);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("CancelTrackingTransport", () => {
	it("records cancelled ids before the message reaches the server", async () => {
		const inner = {
			onmessage: undefined as ((m: unknown) => void) | undefined,
			start: async () => {},
			send: async () => {},
			close: async () => {},
		};
		const t = new CancelTrackingTransport(
			inner as unknown as ConstructorParameters<
				typeof CancelTrackingTransport
			>[0],
		);
		const seen: boolean[] = [];
		t.onmessage = () => seen.push(t.wasCancelled(7));
		await t.start();
		inner.onmessage?.({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 7 },
		});
		expect(seen).toEqual([true]);
		expect(t.wasCancelled("7")).toBe(false);
		expect(t.wasCancelled(8)).toBe(false);
	});
});
