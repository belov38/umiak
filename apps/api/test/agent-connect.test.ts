// ConnectAgentApi over an in-memory Connect transport (createRouterTransport):
// the proto ↔ AgentApi rules of apps/api/README.md "Wiring S3" and the error
// classification of agentErrorToHttp.
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
	Code,
	ConnectError,
	createRouterTransport,
	type HandlerContext,
	type ServiceImpl,
	type Transport,
} from "@connectrpc/connect";
import {
	type AgentFetchInit,
	AgentUnavailableError,
	HEADER_REQUEST_ID,
} from "@umiak/agent-client";
import { ErrorDetailSchema } from "@umiak/proto";
import {
	type AttachResponse,
	CommandInfoSchema,
	CommandState,
	ExitReason,
	ExitStatus,
	FileInfoSchema,
	Filesystem,
	FileType,
	Process,
	Stream,
	System,
} from "@umiak/proto/agent/v1";
import { describe, expect, it } from "vitest";
import {
	AgentCallError,
	type AgentCommandSpec,
	agentErrorToHttp,
	ConnectAgentApi,
	isAgentOutcomeUnknown,
	isAgentUnreachable,
} from "../src/index.ts";

type Impl = {
	process?: Partial<ServiceImpl<typeof Process>>;
	filesystem?: Partial<ServiceImpl<typeof Filesystem>>;
	system?: Partial<ServiceImpl<typeof System>>;
};

/** A ConnectAgentApi whose transport serves `impl` in memory. */
function api(
	impl: Impl,
	o: { transport?: Transport; rows?: { capabilities: string[] | null }[] } = {},
) {
	const machines: string[] = [];
	const fetches: [string, string, AgentFetchInit][] = [];
	const required: [string, string][] = [];
	const transport =
		o.transport ??
		createRouterTransport((r) => {
			r.service(Process, impl.process ?? {});
			r.service(Filesystem, impl.filesystem ?? {});
			r.service(System, impl.system ?? {});
		});
	const client = {
		transport: (m: string) => {
			machines.push(m);
			return transport;
		},
		fetch: async (m: string, p: string, init: AgentFetchInit = {}) => {
			fetches.push([m, p, init]);
			return new Response("x", { status: 206 });
		},
		requireCapability: async (m: string, cap: string) => {
			required.push([m, cap]);
		},
	};
	const queries: unknown[][] = [];
	const pool = {
		query: async (_sql: string, params: unknown[]) => {
			queries.push(params);
			return { rows: o.rows ?? [] };
		},
	};
	return {
		agent: new ConnectAgentApi(client, pool as never),
		machines,
		fetches,
		required,
		queries,
	};
}

const requestId = (ctx: HandlerContext) =>
	ctx.requestHeader.get(HEADER_REQUEST_ID);

function detailError(code: Code, detail: string, message = "boom") {
	return new ConnectError(message, code, undefined, [
		{ desc: ErrorDetailSchema, value: { code: detail, retryable: false } },
	]);
}

const at = new Date("2026-10-30T12:00:00.000Z");
const ts = timestampFromDate(at);

/** A running command as the agent reports it. */
function runningInfo(over: Record<string, unknown> = {}) {
	return create(CommandInfoSchema, {
		commandId: "c1",
		state: CommandState.RUNNING,
		pid: 4242,
		startedAt: ts,
		streams: [
			{ stream: Stream.STDOUT, size: 5n, availableFrom: 0n },
			{ stream: Stream.STDERR, size: 0n, availableFrom: 0n },
		],
		...over,
	});
}

const SPEC: AgentCommandSpec = {
	shell: "echo hi",
	cwd: "work",
	env: { A: "1" },
	user: "user",
	stdin: true,
	timeoutMs: 1500,
	tags: { t: "v" },
	pty: { cols: 100, rows: 30, term: "xterm" },
};

describe("ConnectAgentApi: Process", () => {
	it("start: the spec in proto form, Umiak-Request-Id, the info in AgentApi form", async () => {
		let seen: { req: unknown; id: string | null } | undefined;
		const { agent, machines } = api({
			process: {
				start(req, ctx) {
					seen = { req, id: requestId(ctx) };
					return { command: runningInfo(), created: true };
				},
			},
		});
		const r = await agent.start(
			"m1",
			{ commandId: "c1", spec: SPEC },
			{ requestId: "11111111-2222-3333-4444-555555555555" },
		);
		expect(machines).toEqual(["m1"]);
		expect(seen?.id).toBe("11111111-2222-3333-4444-555555555555");
		expect(seen?.req).toMatchObject({
			commandId: "c1",
			spec: {
				cmd: { case: "shell", value: "echo hi" },
				cwd: "work",
				env: { A: "1" },
				user: "user",
				stdin: true,
				timeoutMs: 1500n,
				tags: { t: "v" },
				pty: { cols: 100, rows: 30, term: "xterm" },
			},
		});
		expect(r).toEqual({
			created: true,
			command: {
				commandId: "c1",
				state: "running",
				pid: 4242,
				exit: null,
				streams: {
					stdout: { size: 5, availableFrom: 0, end: null },
					stderr: { size: 0, availableFrom: 0, end: null },
				},
				startedAt: at,
				endedAt: null,
				outputTruncated: null,
			},
		});
	});

	it("start with argv and no pty", async () => {
		let spec: unknown;
		const { agent } = api({
			process: {
				start(req) {
					spec = req.spec;
					return { command: runningInfo(), created: false };
				},
			},
		});
		const r = await agent.start(
			"m1",
			{
				commandId: "c1",
				spec: {
					cwd: "",
					env: {},
					user: "user",
					stdin: false,
					timeoutMs: 0,
					tags: {},
					argv: ["ls", "-l"],
				},
			},
			{ requestId: "r" },
		);
		expect(r.created).toBe(false);
		expect(spec).toMatchObject({
			cmd: { case: "argv", value: { args: ["ls", "-l"] } },
		});
		expect((spec as { pty?: unknown }).pty).toBeUndefined();
	});

	it("zeros are null: pid 0, signal '', output_truncated '', unset timestamps and stream end", async () => {
		const { agent } = api({
			process: {
				get: () => ({
					command: runningInfo({
						state: CommandState.STARTING,
						pid: 0,
						startedAt: undefined,
					}),
				}),
			},
		});
		const info = await agent.get("m1", "c1");
		expect(info).toMatchObject({
			state: "starting",
			pid: null,
			startedAt: null,
			endedAt: null,
			outputTruncated: null,
			exit: null,
		});
		expect(info.streams.stdout?.end).toBeNull();
	});

	it("an exited command: exit code 0 is a code, UNSPECIFIED reason is null (unknown), ends and output_truncated", async () => {
		const { agent } = api({
			process: {
				get: () => ({
					command: runningInfo({
						state: CommandState.EXITED,
						exit: {
							status: ExitStatus.EXITED,
							code: 0,
							signal: "",
							reason: ExitReason.UNSPECIFIED,
						},
						endedAt: ts,
						outputTruncated: "disk_full",
						streams: [
							{ stream: Stream.UNSPECIFIED, size: 9n },
							{ stream: Stream.PTY, size: 7n, availableFrom: 2n, end: 7n },
						],
					}),
				}),
			},
		});
		const info = await agent.get("m1", "c1");
		expect(info).toMatchObject({
			state: "exited",
			exit: { status: "exited", code: 0, signal: null, reason: null },
			endedAt: at,
			outputTruncated: "disk_full",
			streams: { pty: { size: 7, availableFrom: 2, end: 7 } },
		});
		expect(Object.keys(info.streams)).toEqual(["pty"]);
	});

	it("enum names: killed by a signal, pty_idle, timeout, start_failed", async () => {
		const cases: [ExitStatus, ExitReason, string, string][] = [
			[ExitStatus.KILLED, ExitReason.SIGNAL, "killed", "signal"],
			[ExitStatus.KILLED, ExitReason.PTY_IDLE, "killed", "pty_idle"],
			[ExitStatus.KILLED, ExitReason.TIMEOUT, "killed", "timeout"],
			[ExitStatus.EXITED, ExitReason.START_FAILED, "exited", "start_failed"],
			[ExitStatus.LOST, ExitReason.SHIM_LOST, "lost", "shim_lost"],
			[ExitStatus.LOST, ExitReason.REBOOT, "lost", "reboot"],
			[ExitStatus.KILLED, ExitReason.OOM, "killed", "oom"],
		];
		for (const [status, reason, s, r] of cases) {
			const { agent } = api({
				process: {
					get: () => ({
						command: runningInfo({
							state: CommandState.EXITED,
							exit: { status, code: 137, signal: "SIGKILL", reason },
						}),
					}),
				},
			});
			expect((await agent.get("m1", "c1")).exit).toEqual({
				status: s,
				code: 137,
				signal: "SIGKILL",
				reason: r,
			});
		}
	});

	it("UNSPECIFIED state, or exit status with an exit, is an adapter error (502 agent_error)", async () => {
		for (const over of [
			{ state: CommandState.UNSPECIFIED },
			{
				state: CommandState.EXITED,
				exit: {
					status: ExitStatus.UNSPECIFIED,
					code: 1,
					reason: ExitReason.NONE,
				},
			},
		]) {
			const { agent } = api({
				process: { get: () => ({ command: runningInfo(over) }) },
			});
			const e = await agent.get("m1", "c1").catch((x: unknown) => x);
			expect(e).toBeInstanceOf(AgentCallError);
			expect(agentErrorToHttp(e)).toMatchObject({
				status: 502,
				code: "agent_error",
			});
		}
		const { agent } = api({ process: { get: () => ({}) } });
		await expect(agent.get("m1", "c1")).rejects.toBeInstanceOf(AgentCallError);
	});

	it("an unknown numeric enum (ExitReason 99, ExitStatus 42) is bad_response, never guessed", async () => {
		for (const exit of [
			{ status: ExitStatus.EXITED, code: 0, reason: 99 as ExitReason },
			{ status: 42 as ExitStatus, code: 0, reason: ExitReason.NONE },
		]) {
			const { agent } = api({
				process: {
					get: () => ({
						command: runningInfo({ state: CommandState.EXITED, exit }),
					}),
				},
			});
			const e = await agent.get("m1", "c1").catch((x: unknown) => x);
			expect(e).toBeInstanceOf(AgentCallError);
			expect((e as AgentCallError).code).toBe("bad_response");
		}
	});

	it("attach: an exit event with status UNSPECIFIED or an unknown reason is bad_response", async () => {
		for (const value of [
			{ status: ExitStatus.UNSPECIFIED, code: 1, reason: ExitReason.NONE },
			{ status: ExitStatus.EXITED, code: 1, reason: 99 as ExitReason },
		]) {
			const { agent } = api({
				process: {
					async *attach() {
						yield { event: { case: "exit", value } };
					},
				},
			});
			const e = await (async () => {
				for await (const _ of agent.attach(
					"m1",
					{ commandId: "c1", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
					new AbortController().signal,
				)) {
					// drain
				}
			})().catch((x: unknown) => x);
			expect(e).toBeInstanceOf(AgentCallError);
			expect((e as AgentCallError).code).toBe("bad_response");
			expect(agentErrorToHttp(e)).toMatchObject({
				status: 502,
				code: "agent_error",
			});
		}
	});

	it("uint64 beyond 2^53 − 1 is an adapter error, never truncated; MAX_SAFE_INTEGER passes", async () => {
		const max = BigInt(Number.MAX_SAFE_INTEGER);
		const { agent: ok } = api({
			process: {
				get: () => ({
					command: runningInfo({
						streams: [{ stream: Stream.STDOUT, size: max, availableFrom: max }],
					}),
				}),
			},
		});
		expect((await ok.get("m1", "c1")).streams.stdout?.size).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		const { agent: big } = api({
			process: {
				get: () => ({
					command: runningInfo({
						streams: [{ stream: Stream.STDOUT, size: max + 1n }],
					}),
				}),
			},
		});
		const e = await big.get("m1", "c1").catch((x: unknown) => x);
		expect(e).toBeInstanceOf(AgentCallError);
		expect((e as AgentCallError).code).toBe("bad_response");
	});

	it("attach: offsets as bigint, follow and tailBytes only when set; events mapped, UNSPECIFIED streams skipped", async () => {
		const reqs: unknown[] = [];
		const events: AttachResponse["event"][] = [
			{
				case: "data",
				value: {
					stream: Stream.STDOUT,
					offset: 3n,
					data: new Uint8Array([104, 105]),
				} as never,
			},
			{
				case: "data",
				value: {
					stream: Stream.UNSPECIFIED,
					offset: 0n,
					data: new Uint8Array([1]),
				} as never,
			},
			{
				case: "truncated",
				value: { stream: Stream.STDERR, availableFrom: 10n } as never,
			},
			{
				case: "truncated",
				value: { stream: Stream.UNSPECIFIED, availableFrom: 1n } as never,
			},
			{ case: "heartbeat", value: {} as never },
			{
				case: "exit",
				value: {
					status: ExitStatus.KILLED,
					code: 143,
					signal: "SIGTERM",
					reason: ExitReason.SIGNAL,
					stdoutEnd: 5n,
					stderrEnd: 12n,
					ptyEnd: 0n,
					endedAt: ts,
					outputTruncated: "",
				} as never,
			},
		];
		const { agent } = api({
			process: {
				async *attach(req) {
					reqs.push(req);
					for (const event of events) yield { event };
				},
			},
		});
		const got = [];
		for await (const ev of agent.attach(
			"m1",
			{ commandId: "c1", stdoutOffset: 3, stderrOffset: 0, ptyOffset: 0 },
			new AbortController().signal,
		)) {
			got.push(ev);
		}
		expect(got).toEqual([
			{
				type: "data",
				stream: "stdout",
				offset: 3,
				data: new Uint8Array([104, 105]),
			},
			{ type: "truncated", stream: "stderr", availableFrom: 10 },
			{ type: "heartbeat" },
			{
				type: "exit",
				status: "killed",
				code: 143,
				signal: "SIGTERM",
				reason: "signal",
				stdoutEnd: 5,
				stderrEnd: 12,
				ptyEnd: 0,
				endedAt: at,
				outputTruncated: null,
			},
		]);
		expect(reqs[0]).toMatchObject({
			commandId: "c1",
			stdoutOffset: 3n,
			stderrOffset: 0n,
			ptyOffset: 0n,
			tailBytes: 0n,
		});
		expect((reqs[0] as { follow?: boolean }).follow).toBeUndefined();

		for await (const _ of agent.attach(
			"m1",
			{
				commandId: "c1",
				stdoutOffset: 0,
				stderrOffset: 0,
				ptyOffset: 9,
				tailBytes: 4,
				follow: false,
			},
			new AbortController().signal,
		)) {
			// drain
		}
		expect(reqs[1]).toMatchObject({
			ptyOffset: 9n,
			tailBytes: 4n,
			follow: false,
		});
	});

	it("attach: an exit with output_truncated, and a started event", async () => {
		const { agent } = api({
			process: {
				async *attach() {
					yield {
						event: {
							case: "started",
							value: { commandId: "c1", command: runningInfo() },
						},
					};
					yield {
						event: {
							case: "exit",
							value: {
								status: ExitStatus.EXITED,
								code: 3,
								reason: ExitReason.NONE,
								stdoutEnd: 5n,
								outputTruncated: "disk_full",
							},
						},
					};
				},
			},
		});
		const got = [];
		for await (const ev of agent.attach(
			"m1",
			{ commandId: "c1", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
			new AbortController().signal,
		)) {
			got.push(ev);
		}
		expect(got[0]).toMatchObject({
			type: "started",
			command: { state: "running", pid: 4242 },
		});
		expect(got[1]).toMatchObject({
			type: "exit",
			code: 3,
			signal: null,
			endedAt: null,
			outputTruncated: "disk_full",
		});
	});

	it("attach: an error after some events is mapped like a unary error", async () => {
		const { agent } = api({
			process: {
				async *attach() {
					yield {
						event: {
							case: "data",
							value: {
								stream: Stream.STDOUT,
								offset: 0n,
								data: new Uint8Array([1]),
							},
						},
					};
					throw detailError(Code.NotFound, "command_not_found");
				},
			},
		});
		const got: unknown[] = [];
		const e = await (async () => {
			for await (const ev of agent.attach(
				"m1",
				{ commandId: "c1", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
				new AbortController().signal,
			)) {
				got.push(ev);
			}
		})().catch((x: unknown) => x);
		expect(got).toHaveLength(1);
		expect(e).toBeInstanceOf(AgentCallError);
		expect((e as AgentCallError).code).toBe("command_not_found");
	});

	it("sendInput: seq from the request as bigint, data and close_stdin; update, signal, kill", async () => {
		const seen: Record<string, unknown> = {};
		const { agent } = api({
			process: {
				sendInput(req, ctx) {
					seen.input = req;
					seen.inputId = requestId(ctx);
					return { applied: req.seq === 1n };
				},
				update(req) {
					seen.update = req;
					return {};
				},
				signal(req) {
					seen.signal = req;
					return { command: runningInfo() };
				},
				kill(req) {
					seen.kill = req;
					return { command: runningInfo() };
				},
			},
		});
		const r = await agent.sendInput("m1", {
			commandId: "c1",
			inputSessionId: "s",
			seq: 1,
			data: new Uint8Array([7]),
			closeStdin: true,
		});
		expect(r).toEqual({ applied: true });
		expect(seen.input).toMatchObject({
			commandId: "c1",
			inputSessionId: "s",
			seq: 1n,
			data: new Uint8Array([7]),
			closeStdin: true,
		});
		expect(seen.inputId).toBeNull();
		await agent.update("m1", { commandId: "c1", cols: 90, rows: 20 });
		expect(seen.update).toMatchObject({ commandId: "c1", cols: 90, rows: 20 });
		const s = await agent.signal("m1", { commandId: "c1", signal: "SIGINT" });
		expect(s.pid).toBe(4242);
		expect(seen.signal).toMatchObject({ commandId: "c1", signal: "SIGINT" });
		await agent.kill("m1", { commandId: "c1" });
		expect((seen.kill as { graceMs?: number }).graceMs).toBeUndefined();
		await agent.kill("m1", { commandId: "c1", graceMs: 0 });
		expect((seen.kill as { graceMs?: number }).graceMs).toBe(0);
	});
});

describe("ConnectAgentApi: Filesystem and System", () => {
	const fileInfo = (over: Record<string, unknown> = {}) =>
		create(FileInfoSchema, {
			path: "/home/user/a",
			name: "a",
			type: FileType.FILE,
			size: 12n,
			mode: 0o644,
			owner: "user",
			group: "user",
			uid: 1000,
			gid: 1000,
			mtime: ts,
			...over,
		});

	it("stat and list: FileInfo in AgentApi form, optional fields only when set", async () => {
		const seen: Record<string, unknown> = {};
		const { agent } = api({
			filesystem: {
				stat(req) {
					seen.stat = req;
					return {
						info: fileInfo({
							type: FileType.SYMLINK,
							symlinkTarget: "b",
							mtime: undefined,
						}),
					};
				},
				list(req) {
					seen.list = req;
					return {
						entries: [
							fileInfo(),
							fileInfo({ type: FileType.DIR, name: "d" }),
							fileInfo({ type: FileType.OTHER }),
							fileInfo({ type: FileType.UNSPECIFIED }),
						],
						nextPageToken: "/home/user/d",
					};
				},
			},
		});
		const s = await agent.stat("m1", { path: "a", noFollow: true });
		expect(s).toEqual({
			path: "/home/user/a",
			name: "a",
			type: "symlink",
			size: 12,
			mode: 0o644,
			owner: "user",
			group: "user",
			uid: 1000,
			gid: 1000,
			mtime: null,
			symlinkTarget: "b",
		});
		expect(seen.stat).toMatchObject({ path: "a", user: "", noFollow: true });
		const l = await agent.list("m1", {
			path: "~",
			depth: 2,
			pageSize: 10,
			pageToken: "x",
		});
		expect(l.entries.map((e) => e.type)).toEqual([
			"file",
			"dir",
			"other",
			"other",
		]);
		expect(l.entries[0]?.mtime).toEqual(at);
		expect(l.nextPageToken).toBe("/home/user/d");
		expect(seen.list).toMatchObject({
			path: "~",
			depth: 2,
			pageSize: 10,
			pageToken: "x",
		});
		expect(
			(seen.list as { includeHidden?: boolean }).includeHidden,
		).toBeUndefined();
		await agent.list("m1", { path: "~", includeHidden: false });
		expect(seen.list).toMatchObject({ includeHidden: false });
	});

	it("mutations carry Umiak-Request-Id: makeDir, move, chmod, remove", async () => {
		const ids: Record<string, string | null> = {};
		const reqs: Record<string, unknown> = {};
		const { agent } = api({
			filesystem: {
				makeDir(req, ctx) {
					ids.mkdir = requestId(ctx);
					reqs.mkdir = req;
					return { info: fileInfo({ type: FileType.DIR }), created: true };
				},
				move(req, ctx) {
					ids.move = requestId(ctx);
					reqs.move = req;
					return { info: fileInfo() };
				},
				chmod(req, ctx) {
					ids.chmod = requestId(ctx);
					reqs.chmod = req;
					return { info: fileInfo({ mode: 0o4755 }) };
				},
				remove(req, ctx) {
					ids.remove = requestId(ctx);
					reqs.remove = req;
					return { existed: true };
				},
			},
		});
		const mk = await agent.makeDir("m1", {
			path: "d",
			parents: true,
			mode: 0o700,
			requestId: "id-mkdir",
		});
		expect(mk).toMatchObject({ created: true, info: { type: "dir" } });
		expect(reqs.mkdir).toMatchObject({ path: "d", parents: true, mode: 0o700 });
		await agent.makeDir("m1", { path: "e", requestId: "id-mkdir-2" });
		expect((reqs.mkdir as { mode?: number }).mode).toBeUndefined();
		await agent.move("m1", {
			src: "a",
			dst: "b",
			overwrite: true,
			requestId: "id-move",
		});
		expect(reqs.move).toMatchObject({ src: "a", dst: "b", overwrite: true });
		const ch = await agent.chmod("m1", {
			path: "a",
			mode: 0o4755,
			recursive: true,
			requestId: "id-chmod",
		});
		expect(ch.mode).toBe(0o4755);
		expect(reqs.chmod).toMatchObject({
			path: "a",
			mode: 0o4755,
			recursive: true,
		});
		expect(
			await agent.remove("m1", {
				path: "a",
				recursive: true,
				requestId: "id-remove",
			}),
		).toEqual({ existed: true });
		expect(ids).toEqual({
			mkdir: "id-mkdir-2",
			move: "id-move",
			chmod: "id-chmod",
			remove: "id-remove",
		});
	});

	it("listPorts, updateEnv and updateSecrets (with Umiak-Request-Id)", async () => {
		const seen: Record<string, unknown> = {};
		const { agent } = api({
			system: {
				listPorts: () => ({
					ports: [
						{
							port: 8000,
							addresses: ["0.0.0.0"],
							pid: 12,
							process: "py",
							user: "u",
						},
					],
				}),
				updateEnv(req, ctx) {
					seen.env = [req.env, requestId(ctx)];
					return { ready: true };
				},
				updateSecrets(req, ctx) {
					seen.secrets = [req, requestId(ctx)];
					return { ready: false };
				},
			},
		});
		expect(await agent.listPorts("m1")).toEqual([
			{ port: 8000, addresses: ["0.0.0.0"], pid: 12, process: "py", user: "u" },
		]);
		expect(await agent.updateEnv("m1", { A: "1" }, "id-env")).toEqual({
			ready: true,
		});
		expect(seen.env).toEqual([{ A: "1" }, "id-env"]);
		expect(
			await agent.updateSecrets(
				"m1",
				{
					secretEnv: { S: "x" },
					secretFiles: [
						{
							name: "f",
							content: new Uint8Array([1]),
							mode: 0o400,
							linkPath: "",
						},
					],
				},
				"id-sec",
			),
		).toEqual({ ready: false });
		expect(seen.secrets).toMatchObject([
			{
				secretEnv: { S: "x" },
				secretFiles: [{ name: "f", content: new Uint8Array([1]), mode: 0o400 }],
			},
			"id-sec",
		]);
	});

	it("files, requireCapability and capabilities", async () => {
		const { agent, fetches, required, queries } = api(
			{},
			{ rows: [{ capabilities: ["process.v1"] }] },
		);
		const init: AgentFetchInit = { headers: { Range: "bytes=0-1" } };
		expect((await agent.files("m1", "?path=a", init)).status).toBe(206);
		expect(fetches).toEqual([["m1", "?path=a", init]]);
		await agent.requireCapability("m1", "files.v1");
		expect(required).toEqual([["m1", "files.v1"]]);
		expect(await agent.capabilities("m1")).toEqual(["process.v1"]);
		expect(queries).toEqual([["m1"]]);
		const none = api({}, { rows: [{ capabilities: null }] });
		expect(await none.agent.capabilities("m2")).toEqual([]);
	});
});

describe("ConnectAgentApi: errors", () => {
	const failing = (err: Error) =>
		api({
			filesystem: {
				stat() {
					throw err;
				},
			},
		}).agent;

	it("an ErrorDetail code becomes AgentCallError(code, message)", async () => {
		const e = await failing(
			detailError(Code.NotFound, "path_not_found", "no such file"),
		)
			.stat("m1", { path: "x" })
			.catch((x: unknown) => x);
		expect(e).toBeInstanceOf(AgentCallError);
		expect(e).toMatchObject({
			code: "path_not_found",
			message: "no such file",
		});
		expect(agentErrorToHttp(e)).toMatchObject({
			status: 404,
			code: "path_not_found",
		});
	});

	it("without a detail the Connect code in snake_case", async () => {
		const e = await failing(new ConnectError("x", Code.FailedPrecondition))
			.stat("m1", { path: "x" })
			.catch((x: unknown) => x);
		expect(e).toMatchObject({ code: "failed_precondition" });
		const u = await failing(new ConnectError("x", Code.Unimplemented))
			.stat("m1", { path: "x" })
			.catch((x: unknown) => x);
		expect(agentErrorToHttp(u)).toMatchObject({
			status: 409,
			code: "agent_outdated",
		});
	});

	it("request_id_reused is 409 idempotency_key_reused", async () => {
		const e = await failing(
			detailError(Code.AlreadyExists, "request_id_reused"),
		)
			.stat("m1", { path: "x" })
			.catch((x: unknown) => x);
		expect(agentErrorToHttp(e)).toMatchObject({
			status: 409,
			code: "idempotency_key_reused",
		});
	});

	it("Unavailable (any detail) and Canceled stay ConnectError: unreachable", async () => {
		for (const err of [
			detailError(Code.Unavailable, "quiesced"),
			detailError(Code.Unavailable, "shim_unavailable"),
			new ConnectError("x", Code.Unavailable),
			new ConnectError("x", Code.Canceled),
		]) {
			const e = await failing(err)
				.stat("m1", { path: "x" })
				.catch((x: unknown) => x);
			expect(e).toBeInstanceOf(ConnectError);
			expect(e).not.toBeInstanceOf(AgentCallError);
			expect(isAgentUnreachable(e)).toBe(true);
			expect(agentErrorToHttp(e)).toMatchObject({
				status: 503,
				retryable: true,
			});
		}
	});

	it("DeadlineExceeded stays ConnectError: the outcome of a mutation is unknown", async () => {
		const e = await failing(new ConnectError("slow", Code.DeadlineExceeded))
			.stat("m1", { path: "x" })
			.catch((x: unknown) => x);
		expect(e).toBeInstanceOf(ConnectError);
		expect(isAgentUnreachable(e)).toBe(false);
		expect(isAgentOutcomeUnknown(e)).toBe(true);
	});

	it("AgentUnavailableError and connection errors of the transport pass through", async () => {
		const unavailable = new AgentUnavailableError("m1");
		const reset = Object.assign(new Error("reset"), { code: "ECONNRESET" });
		for (const err of [unavailable, reset]) {
			const transport: Transport = {
				unary: () => Promise.reject(err),
				stream: () => Promise.reject(err),
			};
			const { agent } = api({}, { transport });
			await expect(agent.get("m1", "c1")).rejects.toBe(err);
			const it = agent
				.attach(
					"m1",
					{ commandId: "c1", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
					new AbortController().signal,
				)
				[Symbol.asyncIterator]();
			await expect(it.next()).rejects.toBe(err);
		}
	});

	it("without a client (no gateway token) every call is agent_unavailable", async () => {
		const agent = new ConnectAgentApi(null, {
			query: async () => ({ rows: [] }),
		} as never);
		await expect(agent.get("m1", "c1")).rejects.toBeInstanceOf(
			AgentUnavailableError,
		);
		await expect(agent.files("m1", "", {})).rejects.toBeInstanceOf(
			AgentUnavailableError,
		);
		await expect(
			agent.requireCapability("m1", "files.v1"),
		).rejects.toBeInstanceOf(AgentUnavailableError);
		const it = agent
			.attach(
				"m1",
				{ commandId: "c1", stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
				new AbortController().signal,
			)
			[Symbol.asyncIterator]();
		await expect(it.next()).rejects.toBeInstanceOf(AgentUnavailableError);
	});
});
