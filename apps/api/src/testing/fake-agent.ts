// FakeAgent: an in-process AgentApi for api, SDK and CLI tests. It follows
// the S3 contract (§9–§13) closely enough that code written against it works
// with the real agent:
// - commands are real processes (`/bin/bash -lc <shell>` or argv) in their
//   own process group, cwd relative to a per-machine temporary home; output
//   is kept in memory with stable offsets; Start is idempotent by commandId;
// - a PTY command is the same process without a terminal: stdout and stderr
//   go to the single stream "pty", `update` records sizes;
// - attach: truncated, heartbeat, exit only after all output (S2 §9.1);
// - `/files*` HTTP (downloads with Range, uploads, tar archives through the
//   system `tar`) and Filesystem RPC over the real directory;
// - faults: failNextAttach, setUnavailable, retention, chunkSize.
// Guest paths are host paths: "~", "~/x" and relative paths resolve against
// the machine's home, absolute paths are used as they are.
// Call close() (afterAll): it kills every process group and removes the
// temporary directories.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { constants as osConstants, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";
import {
	type AgentFetchInit,
	AgentOutdatedError,
	AgentUnavailableError,
} from "@sbx/agent-client";
import { AgentCallError } from "../agent/errors.ts";
import { agentFileInfoJson } from "../agent/files-http.ts";
import {
	AGENT_CAPABILITIES,
	type AgentApi,
	type AgentAttachEvent,
	type AgentAttachRequest,
	type AgentChmodRequest,
	type AgentCommandInfo,
	type AgentCommandSpec,
	type AgentCommandState,
	type AgentExitInfo,
	type AgentFileInfo,
	type AgentKillRequest,
	type AgentListRequest,
	type AgentListResult,
	type AgentMakeDirRequest,
	type AgentMakeDirResult,
	type AgentMoveRequest,
	type AgentPort,
	type AgentReadiness,
	type AgentRemoveRequest,
	type AgentSecretFile,
	type AgentSecrets,
	type AgentSendInputRequest,
	type AgentSignalRequest,
	type AgentStartRequest,
	type AgentStartResult,
	type AgentStatRequest,
	type AgentStream,
	type AgentStreamInfo,
	type AgentUpdateRequest,
} from "../agent/types.ts";

export interface FakeAgentOptions {
	/** Max bytes of one attach data event. Default 64 KiB. */
	chunkSize?: number;
	/** Silence before an attach heartbeat. Default 15 000 ms. */
	heartbeatMs?: number;
	/** Capabilities of new machines. Default: all of S3 §13. */
	capabilities?: string[];
	/** Default 256 (S3 §9.7). */
	maxRunningCommands?: number;
	/** Max upload chunk. Default 8 MiB. */
	maxChunkBytes?: number;
	/** Archive upload limits (S3 §11.2). Defaults 200 000, 16 GiB, 4 096. */
	archiveMaxEntries?: number;
	archiveMaxBytes?: number;
	archiveMaxPath?: number;
}

export type FakeAttachFailure = "unavailable" | "reset";

/** The test-facing state of one fake machine; edit the fields freely. */
export class FakeMachine {
	readonly id: string;
	/** The default user's home (a temporary directory). */
	readonly home: string;
	capabilities: string[];
	/** What `listPorts` returns. */
	ports: AgentPort[] = [];
	/** Sandbox env (`updateEnv`), applied to new commands. */
	env: Record<string, string> = {};
	/** `updateSecrets`: applied to new commands; files are kept here only. */
	secretEnv: Record<string, string> = {};
	secretFiles: AgentSecretFile[] = [];

	constructor(id: string, home: string, capabilities: string[]) {
		this.id = id;
		this.home = home;
		this.capabilities = capabilities;
	}
}

interface MachineState {
	machine: FakeMachine;
	spool: string;
	unavailable: boolean;
	failNext: { afterBytes: number; kind: FakeAttachFailure } | null;
	commands: Map<string, FakeCommand>;
	uploads: Map<string, Upload>;
	/** Serializes upload requests. */
	uploadLock: Promise<unknown>;
}

interface Upload {
	tempPath: string;
	size: number;
	/** The stored FileInfo JSON of a committed upload. */
	commit: string | null;
}

const DEFAULTS = {
	chunkSize: 64 * 1024,
	heartbeatMs: 15_000,
	maxRunningCommands: 256,
	maxChunkBytes: 8 * 1024 * 1024,
	archiveMaxEntries: 200_000,
	archiveMaxBytes: 16 * 1024 ** 3,
	archiveMaxPath: 4096,
};

/** After the main process exits, how long leftovers may hold its pipes. */
const LEFTOVER_PIPE_MS = 100;

export class FakeAgent implements AgentApi {
	/** Max bytes of one attach data event; 1 for UTF-8 boundary tests. */
	chunkSize: number;
	/** Silence before an attach heartbeat. */
	heartbeatMs: number;

	readonly #opts: Required<
		Omit<FakeAgentOptions, "chunkSize" | "heartbeatMs" | "capabilities">
	>;
	readonly #capabilities: string[];
	readonly #machines = new Map<string, MachineState>();
	readonly #commands = new Map<string, FakeCommand>();
	readonly #starts = new Map<string, number>();
	readonly #tars = new Set<ChildProcess>();
	#retain: number | null = null;
	#root: string | null = null;
	#closed = false;

	static readonly #live = new Set<FakeAgent>();
	static {
		// Safety net for a test run that ends without close().
		process.once("exit", () => {
			for (const f of FakeAgent.#live) f.#killAll("SIGKILL");
			for (const f of FakeAgent.#live) f.#removeRoot();
		});
	}

	constructor(opts: FakeAgentOptions = {}) {
		this.chunkSize = opts.chunkSize ?? DEFAULTS.chunkSize;
		this.heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs;
		this.#capabilities = opts.capabilities ?? [...AGENT_CAPABILITIES];
		this.#opts = {
			maxRunningCommands:
				opts.maxRunningCommands ?? DEFAULTS.maxRunningCommands,
			maxChunkBytes: opts.maxChunkBytes ?? DEFAULTS.maxChunkBytes,
			archiveMaxEntries: opts.archiveMaxEntries ?? DEFAULTS.archiveMaxEntries,
			archiveMaxBytes: opts.archiveMaxBytes ?? DEFAULTS.archiveMaxBytes,
			archiveMaxPath: opts.archiveMaxPath ?? DEFAULTS.archiveMaxPath,
		};
		FakeAgent.#live.add(this);
	}

	// --- test controls ---

	/** The machine, created with an empty home on first use. */
	machine(machineId: string): FakeMachine {
		return this.#state(machineId).machine;
	}

	/** How many times the process of `commandId` was launched. */
	startCount(commandId: string): number {
		return this.#starts.get(commandId) ?? 0;
	}

	/** PTY sizes of a command: the one from its spec, then each `update`. */
	ptySizes(commandId: string): { cols: number; rows: number }[] {
		return [...(this.#commands.get(commandId)?.sizes ?? [])];
	}

	/**
	 * The next attach on the machine fails after `afterBytes` data bytes:
	 * "unavailable" with AgentUnavailableError (the routing budget is spent),
	 * "reset" with a connection reset (resumableAttach reconnects).
	 */
	failNextAttach(
		machineId: string,
		afterBytes: number,
		kind: FakeAttachFailure,
	): void {
		this.#state(machineId).failNext = { afterBytes, kind };
	}

	/** While on, every call fails with AgentUnavailableError and open attaches reset. */
	setUnavailable(machineId: string, on: boolean): void {
		const s = this.#state(machineId);
		s.unavailable = on;
		for (const c of s.commands.values()) c.notify();
	}

	/** Keep at most `bytes` per stream (older output is evicted); null = all. */
	retention(bytes: number | null): void {
		this.#retain = bytes;
		if (bytes === null) return;
		for (const c of this.#commands.values()) {
			for (const b of c.out.values()) b.evict(bytes);
		}
	}

	/** Kills every process group, removes the temporary directories. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#killAll("SIGKILL");
		const live = [...this.#commands.values()].filter((c) => c.exit === null);
		await Promise.race([
			Promise.all(live.map((c) => c.finished)),
			new Promise((r) => setTimeout(r, 5000).unref()),
		]);
		for (const c of this.#commands.values()) c.clearTimers();
		this.#removeRoot();
		FakeAgent.#live.delete(this);
	}

	#killAll(sig: NodeJS.Signals): void {
		for (const c of this.#commands.values()) {
			// Exited commands too: their leftovers share the process group.
			if (c.pid !== null) killGroup(c.pid, sig);
		}
		for (const t of this.#tars) t.kill(sig);
	}

	#removeRoot(): void {
		if (this.#root !== null)
			rmSync(this.#root, { recursive: true, force: true });
		this.#root = null;
	}

	#state(machineId: string): MachineState {
		let s = this.#machines.get(machineId);
		if (s === undefined) {
			if (this.#closed) throw new Error("FakeAgent is closed");
			this.#root ??= realpathSync(
				mkdtempSync(join(tmpdir(), "sbx-fake-agent-")),
			);
			const dir = join(this.#root, `m${this.#machines.size}`);
			const home = join(dir, "home");
			const spool = join(dir, "spool");
			mkdirSync(home, { recursive: true });
			mkdirSync(spool);
			s = {
				machine: new FakeMachine(machineId, home, [...this.#capabilities]),
				spool,
				unavailable: false,
				failNext: null,
				commands: new Map(),
				uploads: new Map(),
				uploadLock: Promise.resolve(),
			};
			this.#machines.set(machineId, s);
		}
		return s;
	}

	/** The machine of an RPC or HTTP call: unavailable → AgentUnavailableError. */
	#reach(machineId: string): MachineState {
		const s = this.#state(machineId);
		if (s.unavailable || this.#closed)
			throw new AgentUnavailableError(machineId);
		return s;
	}

	#command(s: MachineState, commandId: string): FakeCommand {
		const c = s.commands.get(commandId);
		if (c === undefined) {
			throw callError("command_not_found", `command ${commandId} not found`);
		}
		return c;
	}

	// --- capabilities ---

	async capabilities(machineId: string): Promise<string[]> {
		return [...this.#state(machineId).machine.capabilities];
	}

	async requireCapability(
		machineId: string,
		capability: string,
	): Promise<void> {
		const s = this.#reach(machineId);
		if (!s.machine.capabilities.includes(capability)) {
			throw new AgentOutdatedError(machineId, capability);
		}
	}

	// --- Process ---

	async start(
		machineId: string,
		req: AgentStartRequest,
		_opts: { requestId: string; signal?: AbortSignal },
	): Promise<AgentStartResult> {
		const s = this.#reach(machineId);
		const hash = sha256Hex(stableJson(req.spec));
		const existing = s.commands.get(req.commandId);
		if (existing !== undefined) {
			if (existing.specHash !== hash) {
				throw callError(
					"already_exists",
					`command ${req.commandId} exists with another spec`,
				);
			}
			await existing.started;
			return { command: existing.info(), created: false };
		}
		const spec = req.spec;
		if ((spec.shell === undefined) === (spec.argv === undefined)) {
			throw callError(
				"invalid_argument",
				"exactly one of shell or argv is required",
			);
		}
		if (spec.argv !== undefined && spec.argv.length === 0) {
			throw callError("invalid_argument", "argv is empty");
		}
		const running = [...s.commands.values()].filter((c) => c.exit === null);
		if (running.length >= this.#opts.maxRunningCommands) {
			throw callError(
				"too_many_commands",
				`at most ${this.#opts.maxRunningCommands} commands may run`,
			);
		}
		const cmd = new FakeCommand(req.commandId, spec, hash, () => this.#retain);
		s.commands.set(req.commandId, cmd);
		this.#commands.set(req.commandId, cmd);
		this.#starts.set(req.commandId, (this.#starts.get(req.commandId) ?? 0) + 1);
		this.#launch(s, cmd);
		await cmd.started;
		return { command: cmd.info(), created: true };
	}

	#launch(s: MachineState, cmd: FakeCommand): void {
		const spec = cmd.spec;
		const home = s.machine.home;
		const cwd = resolveGuestPath(spec.cwd === "" ? "~" : spec.cwd, home);
		let [program, args] =
			spec.shell !== undefined
				? ["/bin/bash", ["-lc", spec.shell]]
				: [spec.argv?.[0] ?? "", spec.argv?.slice(1) ?? []];
		if (spec.pty) {
			// One fd for stdout and stderr, as on a terminal: output keeps its order.
			args = ["-c", 'exec "$@" 2>&1', "sh", program, ...args];
			program = "/bin/sh";
		}
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: home,
			USER: spec.user,
			LOGNAME: spec.user,
			SHELL: "/bin/bash",
			...(spec.pty ? { TERM: spec.pty.term || "xterm-256color" } : {}),
			...s.machine.env,
			...s.machine.secretEnv,
			...spec.env,
		};
		let child: ChildProcess;
		try {
			const st = statSyncOrNull(cwd);
			if (st === null || !st.isDirectory()) {
				throw new Error(`cwd ${cwd}: no such directory`);
			}
			child = spawn(program, args, {
				cwd,
				env,
				stdio: [cmd.hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
				detached: true,
			});
		} catch (e) {
			cmd.startFailed(errorMessage(e));
			return;
		}
		cmd.attachChild(child, program);
		if (spec.timeoutMs > 0) {
			cmd.addTimer(
				setTimeout(() => {
					cmd.timedOut = true;
					if (cmd.pid !== null) killGroup(cmd.pid, "SIGKILL");
				}, spec.timeoutMs),
			);
		}
	}

	async *attach(
		machineId: string,
		req: AgentAttachRequest,
		signal: AbortSignal,
	): AsyncGenerator<AgentAttachEvent> {
		const s = this.#reach(machineId);
		const cmd = this.#command(s, req.commandId);
		const fail = s.failNext;
		s.failNext = null;
		const failure = () =>
			fail?.kind === "unavailable"
				? new AgentUnavailableError(machineId)
				: connectionReset();
		const streams = cmd.streams;
		const requested: Record<AgentStream, number> = {
			stdout: req.stdoutOffset,
			stderr: req.stderrOffset,
			pty: req.ptyOffset,
		};
		const pos = new Map<AgentStream, number>();
		for (const name of streams) {
			const b = cmd.buffer(name);
			pos.set(
				name,
				req.tailBytes
					? Math.max(b.availableFrom, b.size - req.tailBytes)
					: requested[name],
			);
		}
		const follow = req.follow ?? true;
		let sent = 0;
		for (;;) {
			if (signal.aborted) throw signal.reason;
			if (s.unavailable || this.#closed) throw connectionReset();
			if (fail !== null && sent >= fail.afterBytes) throw failure();
			let progressed = false;
			for (const name of streams) {
				const b = cmd.buffer(name);
				let p = pos.get(name) ?? 0;
				if (p < b.availableFrom) {
					p = b.availableFrom;
					pos.set(name, p);
					progressed = true;
					yield { type: "truncated", stream: name, availableFrom: p };
				}
				if (p < b.size) {
					let n = Math.min(Math.max(1, this.chunkSize), b.size - p);
					if (fail !== null) n = Math.min(n, fail.afterBytes - sent);
					if (n <= 0) throw failure();
					const data = b.read(p, n);
					pos.set(name, p + data.length);
					sent += data.length;
					progressed = true;
					yield { type: "data", stream: name, offset: p, data };
				}
			}
			if (progressed) continue;
			const exit = cmd.exit;
			if (
				exit !== null &&
				streams.every((n) => (pos.get(n) ?? 0) >= cmd.buffer(n).size)
			) {
				yield {
					type: "exit",
					...exit,
					stdoutEnd: cmd.out.get("stdout")?.size ?? 0,
					stderrEnd: cmd.out.get("stderr")?.size ?? 0,
					ptyEnd: cmd.out.get("pty")?.size ?? 0,
					endedAt: cmd.endedAt,
				};
				return;
			}
			if (!follow) return;
			if (await this.#wait(cmd, signal)) yield { type: "heartbeat" };
		}
	}

	/** Waits for new output, exit or abort; true when heartbeatMs passed first. */
	#wait(cmd: FakeCommand, signal: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			const done = (timedOut: boolean) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
				resolve(timedOut);
			};
			const onAbort = () => done(false);
			const timer = setTimeout(() => done(true), this.heartbeatMs);
			signal.addEventListener("abort", onAbort, { once: true });
			cmd.changed().then(() => done(false));
		});
	}

	async sendInput(
		machineId: string,
		req: AgentSendInputRequest,
	): Promise<{ applied: boolean }> {
		const cmd = this.#command(this.#reach(machineId), req.commandId);
		if (cmd.exit !== null) throw commandExited(req.commandId);
		const stdin = cmd.child?.stdin;
		if (!cmd.hasStdin || stdin == null) {
			throw callError("failed_precondition", "the command has no stdin");
		}
		const last = cmd.lastSeq.get(req.inputSessionId);
		if (last !== undefined && req.seq <= last) return { applied: false };
		cmd.lastSeq.set(req.inputSessionId, req.seq);
		if (!stdin.writableEnded) {
			if (req.data.length > 0) stdin.write(req.data);
			// PTY: EOF is a ^D byte from the client, close_stdin does not apply.
			if (req.closeStdin && cmd.spec.pty === undefined) stdin.end();
		}
		return { applied: true };
	}

	async update(machineId: string, req: AgentUpdateRequest): Promise<void> {
		const cmd = this.#command(this.#reach(machineId), req.commandId);
		if (cmd.spec.pty === undefined) {
			throw callError("failed_precondition", "not a PTY command");
		}
		if (cmd.exit !== null) throw commandExited(req.commandId);
		cmd.sizes.push({ cols: req.cols, rows: req.rows });
	}

	async signal(
		machineId: string,
		req: AgentSignalRequest,
	): Promise<AgentCommandInfo> {
		const cmd = this.#command(this.#reach(machineId), req.commandId);
		const sig = parseSignal(req.signal);
		if (cmd.exit === null && cmd.pid !== null) killGroup(cmd.pid, sig);
		return cmd.info();
	}

	async kill(
		machineId: string,
		req: AgentKillRequest,
	): Promise<AgentCommandInfo> {
		const cmd = this.#command(this.#reach(machineId), req.commandId);
		const pid = cmd.pid;
		if (cmd.exit === null && pid !== null) {
			killGroup(pid, "SIGTERM");
			cmd.addTimer(
				setTimeout(() => killGroup(pid, "SIGKILL"), req.graceMs ?? 10_000),
			);
		}
		return cmd.info();
	}

	async get(machineId: string, commandId: string): Promise<AgentCommandInfo> {
		return this.#command(this.#reach(machineId), commandId).info();
	}

	// --- Filesystem ---

	async stat(machineId: string, req: AgentStatRequest): Promise<AgentFileInfo> {
		const s = this.#reach(machineId);
		const p = resolveGuestPath(req.path, s.machine.home);
		return fsCall(() => fileInfo(p, !req.noFollow));
	}

	async list(
		machineId: string,
		req: AgentListRequest,
	): Promise<AgentListResult> {
		const s = this.#reach(machineId);
		const dir = resolveGuestPath(req.path, s.machine.home);
		const depth = req.depth || 1;
		if (depth > 8)
			throw callError("invalid_argument", `depth ${depth} is above 8`);
		const pageSize = Math.min(req.pageSize || 1000, 10_000);
		const st = await fsCall(() => fsp.stat(dir));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${dir} is not a directory`);
		}
		const all: { rel: string[]; info: AgentFileInfo }[] = [];
		const walk = async (abs: string, rel: string[], level: number) => {
			const names = (await fsp.readdir(abs)).sort();
			for (const name of names) {
				if (req.includeHidden === false && name.startsWith(".")) continue;
				const p = join(abs, name);
				const info = await fileInfo(p, false).catch(() => null);
				if (info === null) continue;
				all.push({ rel: [...rel, name], info });
				if (info.type === "dir" && level < depth) {
					await walk(p, [...rel, name], level + 1).catch(() => {});
				}
			}
		};
		await fsCall(() => walk(dir, [], 1));
		let from = 0;
		if (req.pageToken) {
			const tok = resolvePath(req.pageToken);
			if (!tok.startsWith(`${dir}/`)) {
				throw callError("invalid_argument", `page_token is not under ${dir}`);
			}
			const after = tok.slice(dir.length + 1).split("/");
			from = all.findIndex((e) => compareComponents(e.rel, after) > 0);
			if (from < 0) from = all.length;
		}
		const page = all.slice(from, from + pageSize);
		const more = from + pageSize < all.length;
		return {
			entries: page.map((e) => e.info),
			nextPageToken: more ? (page.at(-1)?.info.path ?? "") : "",
		};
	}

	async makeDir(
		machineId: string,
		req: AgentMakeDirRequest,
	): Promise<AgentMakeDirResult> {
		const s = this.#reach(machineId);
		const p = resolveGuestPath(req.path, s.machine.home);
		return fsCall(async () => {
			const st = await fsp.stat(p).catch(() => null);
			if (st !== null) {
				if (!st.isDirectory()) throw callError("already_exists", `${p} exists`);
				return { info: await fileInfo(p, true), created: false };
			}
			const mode = req.mode ?? 0o755;
			await fsp.mkdir(p, { recursive: req.parents === true, mode });
			await fsp.chmod(p, mode);
			return { info: await fileInfo(p, true), created: true };
		});
	}

	async move(machineId: string, req: AgentMoveRequest): Promise<AgentFileInfo> {
		const s = this.#reach(machineId);
		const src = resolveGuestPath(req.src, s.machine.home);
		const dst = resolveGuestPath(req.dst, s.machine.home);
		return fsCall(async () => {
			await fsp.lstat(src);
			if (!req.overwrite && (await fsp.lstat(dst).catch(() => null)) !== null) {
				throw callError("already_exists", `${dst} already exists`);
			}
			await fsp.rename(src, dst);
			return fileInfo(dst, false);
		});
	}

	async chmod(
		machineId: string,
		req: AgentChmodRequest,
	): Promise<AgentFileInfo> {
		const s = this.#reach(machineId);
		const p = resolveGuestPath(req.path, s.machine.home);
		return fsCall(async () => {
			const mode = req.mode;
			if (mode !== undefined) {
				const apply = async (q: string): Promise<void> => {
					const st = await fsp.lstat(q);
					if (st.isSymbolicLink()) return;
					await fsp.chmod(q, mode);
					if (req.recursive && st.isDirectory()) {
						for (const n of await fsp.readdir(q)) await apply(join(q, n));
					}
				};
				await fsp.stat(p);
				await apply(await fsp.realpath(p));
			}
			// owner and group: the fake runs unprivileged and cannot chown.
			return fileInfo(p, true);
		});
	}

	async remove(
		machineId: string,
		req: AgentRemoveRequest,
	): Promise<{ existed: boolean }> {
		const s = this.#reach(machineId);
		const p = resolveGuestPath(req.path, s.machine.home);
		return fsCall(async () => {
			const st = await fsp.lstat(p).catch((e: unknown) => {
				if (errnoOf(e) === "ENOENT") return null;
				throw e;
			});
			if (st === null) return { existed: false };
			if (!st.isDirectory()) await fsp.unlink(p);
			else if (req.recursive) await fsp.rm(p, { recursive: true, force: true });
			else await fsp.rmdir(p);
			return { existed: true };
		});
	}

	// --- System ---

	async listPorts(machineId: string): Promise<AgentPort[]> {
		return structuredClone(this.#reach(machineId).machine.ports);
	}

	async updateEnv(
		machineId: string,
		env: Record<string, string>,
		_requestId: string,
	): Promise<AgentReadiness> {
		this.#reach(machineId).machine.env = { ...env };
		return { ready: true };
	}

	async updateSecrets(
		machineId: string,
		secrets: AgentSecrets,
		_requestId: string,
	): Promise<AgentReadiness> {
		const m = this.#reach(machineId).machine;
		m.secretEnv = { ...secrets.secretEnv };
		m.secretFiles = secrets.secretFiles.map((f) => ({
			...f,
			content: new Uint8Array(f.content),
		}));
		return { ready: true };
	}

	// --- HTTP /files* ---

	async files(
		machineId: string,
		path: string,
		init: AgentFetchInit,
	): Promise<Response> {
		if (path !== "" && !path.startsWith("/") && !path.startsWith("?")) {
			throw new TypeError(`agent fetch path must start with "/": ${path}`);
		}
		const s = this.#reach(machineId);
		const url = new URL(`http://agent/files${path}`);
		const method = (init.method ?? "GET").toUpperCase();
		const raw = typeof init.body === "function" ? init.body() : init.body;
		const reqInit: RequestInit & { duplex?: "half" } = {
			method,
			signal: init.signal ?? null,
		};
		if (init.headers !== undefined) reqInit.headers = init.headers;
		if (raw != null && method !== "GET" && method !== "HEAD") {
			reqInit.body = raw;
			reqInit.duplex = "half";
		}
		const req = new Request(url, reqInit);
		try {
			return await this.#serveFiles(s, req, url);
		} catch (e) {
			return errorResponse(e);
		}
	}

	#serveFiles(s: MachineState, req: Request, url: URL): Promise<Response> {
		const rest = url.pathname.slice("/files".length);
		const m = req.method;
		if (rest === "") {
			if (m === "GET" || m === "HEAD") return this.#download(s, req, url);
			if (m === "PUT") return this.#putFile(s, req, url);
			return Promise.resolve(methodNotAllowed("GET, HEAD, PUT"));
		}
		if (rest === "/archive") {
			if (m === "GET") return this.#archiveGet(s, url);
			if (m === "PUT") return this.#archivePut(s, req, url);
			return Promise.resolve(methodNotAllowed("GET, PUT"));
		}
		if (rest.startsWith("/uploads/")) {
			const segs = rest.slice("/uploads/".length).split("/");
			const id = segs[0] ?? "";
			if (segs.length > 2 || (segs.length === 2 && segs[1] !== "commit")) {
				return Promise.resolve(endpointNotFound());
			}
			if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
				throw callError("invalid_path", "invalid upload id");
			}
			const run = <T>(fn: () => Promise<T>): Promise<T> => {
				const p = s.uploadLock.then(fn, fn);
				s.uploadLock = p.catch(() => {});
				return p;
			};
			if (segs.length === 2) {
				if (m !== "POST") return Promise.resolve(methodNotAllowed("POST"));
				return run(() => this.#commit(s, req, id));
			}
			if (m === "PUT") return run(() => this.#putChunk(s, req, url, id));
			if (m === "HEAD") return run(() => this.#headUpload(s, id));
			if (m === "DELETE") return run(() => this.#deleteUpload(s, id));
			return Promise.resolve(methodNotAllowed("PUT, HEAD, DELETE"));
		}
		return Promise.resolve(endpointNotFound());
	}

	async #download(s: MachineState, req: Request, url: URL): Promise<Response> {
		const p = resolveGuestPath(
			url.searchParams.get("path") ?? "",
			s.machine.home,
		);
		const st = await fsCall(() => fsp.stat(p, { bigint: true }));
		if (st.isDirectory())
			throw callError("is_directory", `${p} is a directory`);
		if (!st.isFile()) {
			throw callError("failed_precondition", `${p} is not a regular file`);
		}
		const size = Number(st.size);
		const etag = `"${st.ino}-${st.size}-${st.mtimeNs}"`;
		const mtime = new Date(Number(st.mtimeMs));
		const headers = new Headers({
			ETag: etag,
			"Last-Modified": mtime.toUTCString(),
			"Accept-Ranges": "bytes",
			"Content-Type": "application/octet-stream",
		});
		let range = req.headers.get("range");
		if (range?.includes(",")) range = null;
		const ifRange = req.headers.get("if-range");
		if (range !== null && ifRange !== null) {
			const matches =
				ifRange.startsWith('"') || ifRange.startsWith("W/")
					? ifRange === etag
					: Date.parse(ifRange) === Math.floor(mtime.getTime() / 1000) * 1000;
			if (!matches) range = null;
		}
		let start = 0;
		let end = size - 1;
		let status = 200;
		if (range !== null) {
			const r = parseRange(range, size);
			if (r === null) {
				return new Response("invalid range", {
					status: 416,
					headers: { "Content-Range": `bytes */${size}` },
				});
			}
			[start, end] = r;
			status = 206;
			headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
		}
		const length = Math.max(0, end - start + 1);
		headers.set("Content-Length", String(length));
		const body =
			req.method === "HEAD" || length === 0
				? null
				: nodeToWeb(createReadStream(p, { start, end }));
		return new Response(body, { status, headers });
	}

	async #putFile(s: MachineState, req: Request, url: URL): Promise<Response> {
		const q = url.searchParams;
		const p = resolveGuestPath(q.get("path") ?? "", s.machine.home);
		const mode = parseMode(q.get("mode")) ?? 0o644;
		const makeParents = queryBool(q, "make_parents", true);
		const overwrite = queryBool(q, "overwrite", true);
		const target = await prepareTarget(p, overwrite, makeParents);
		const tmp = join(dirname(target), `.sbx-tmp-${randomUUID()}`);
		try {
			await fsCall(() => writeBody(req, tmp, mode));
			await fsCall(() => fsp.chmod(tmp, mode));
			await fsCall(() => fsp.rename(tmp, target));
		} finally {
			await fsp.rm(tmp, { force: true });
		}
		return Response.json(agentFileInfoJson(await fileInfo(p, true)));
	}

	async #putChunk(
		s: MachineState,
		req: Request,
		url: URL,
		id: string,
	): Promise<Response> {
		const q = url.searchParams;
		const offsetText = q.get("offset") ?? "";
		if (!/^[0-9]{1,15}$/.test(offsetText)) {
			throw callError(
				"invalid_argument",
				`offset ${JSON.stringify(offsetText)} is not a non-negative integer`,
			);
		}
		const offset = Number(offsetText);
		const max = this.#opts.maxChunkBytes;
		const declared = Number(req.headers.get("content-length") ?? "0");
		if (declared > max) throw chunkTooLarge(max);
		let up = s.uploads.get(id);
		if (up?.commit != null) {
			throw callError(
				"failed_precondition",
				`upload ${id} is already committed`,
				{
					offset: up.size,
				},
				409,
			);
		}
		const current = up?.size ?? 0;
		if (offset !== current) throw offsetMismatch(current, offset);
		const data = await readCapped(req, max);
		if (data === null) throw chunkTooLarge(max);
		if (up === undefined) {
			up = { tempPath: join(s.spool, `upload-${id}`), size: 0, commit: null };
			await fsCall(() => fsp.writeFile((up as Upload).tempPath, ""));
			s.uploads.set(id, up);
		}
		const u = up;
		await fsCall(() => fsp.appendFile(u.tempPath, data));
		u.size += data.length;
		return Response.json(
			{ offset: u.size },
			{ headers: { "Sbx-Upload-Offset": String(u.size) } },
		);
	}

	async #headUpload(s: MachineState, id: string): Promise<Response> {
		const up = s.uploads.get(id);
		if (up === undefined) return new Response(null, { status: 404 });
		return new Response(null, {
			headers: { "Sbx-Upload-Offset": String(up.size) },
		});
	}

	async #deleteUpload(s: MachineState, id: string): Promise<Response> {
		const up = s.uploads.get(id);
		if (up === undefined) throw uploadNotFound(id);
		s.uploads.delete(id);
		if (up.tempPath !== "") await fsp.rm(up.tempPath, { force: true });
		return new Response(null, { status: 204 });
	}

	async #commit(s: MachineState, req: Request, id: string): Promise<Response> {
		const up = s.uploads.get(id);
		if (up === undefined) throw uploadNotFound(id);
		if (up.commit !== null) return jsonText(up.commit);
		const raw = await readCapped(req, 64 * 1024);
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
		} catch (e) {
			throw callError("invalid_argument", `commit body: ${errorMessage(e)}`);
		}
		const p = resolveGuestPath(
			typeof body.path === "string" ? body.path : "",
			s.machine.home,
		);
		let mode = 0o644;
		if (body.mode !== undefined && body.mode !== null) {
			if (
				typeof body.mode !== "number" ||
				body.mode < 0 ||
				body.mode > 0o7777
			) {
				throw callError("invalid_argument", "mode is out of range");
			}
			mode = body.mode;
		}
		const overwrite = body.overwrite !== false;
		const makeParents = (body.make_parents ?? body.makeParents) !== false;
		if (typeof body.sha256 === "string" && body.sha256 !== "") {
			const got = sha256Hex(await fsp.readFile(up.tempPath));
			if (got !== body.sha256.toLowerCase()) {
				s.uploads.delete(id);
				await fsp.rm(up.tempPath, { force: true });
				throw callError("checksum_mismatch", `sha256 of the upload is ${got}`);
			}
		}
		const target = await prepareTarget(p, overwrite, makeParents);
		await fsCall(() => fsp.chmod(up.tempPath, mode));
		await fsCall(() => fsp.rename(up.tempPath, target));
		up.tempPath = "";
		up.commit = JSON.stringify(agentFileInfoJson(await fileInfo(p, true)));
		return jsonText(up.commit);
	}

	async #archiveGet(s: MachineState, url: URL): Promise<Response> {
		const q = url.searchParams;
		const root = resolveGuestPath(q.get("path") ?? "", s.machine.home);
		const gz = parseFormat(q.get("format"));
		const st = await fsCall(() => fsp.stat(root));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${root} is not a directory`);
		}
		const real = await fsp.realpath(root);
		const names = (await fsp.readdir(real)).sort();
		const contentType = gz ? "application/gzip" : "application/x-tar";
		let tar: Readable;
		if (names.length === 0) {
			tar = Readable.from([Buffer.alloc(1024)]);
		} else {
			const child = spawn(
				"tar",
				["-c", "-f", "-", "--format=pax", "-C", real, "--", ...names],
				{
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env, COPYFILE_DISABLE: "1" },
				},
			);
			this.#tars.add(child);
			const out = new PassThrough();
			let stderr = "";
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.stdout.pipe(out, { end: false });
			child.on("close", (code) => {
				this.#tars.delete(child);
				// A failed walk ends the body without tar's end blocks.
				if (code === 0) out.end();
				else out.destroy(new Error(`tar: ${stderr.trim()}`));
			});
			tar = out;
		}
		const body: Readable = gz ? tar.pipe(createGzip()) : tar;
		return new Response(nodeToWeb(body), {
			headers: { "Content-Type": contentType },
		});
	}

	async #archivePut(
		s: MachineState,
		req: Request,
		url: URL,
	): Promise<Response> {
		try {
			return await this.#unpack(s, req, url);
		} catch (e) {
			return errorResponse(e, { entries_written: 0 });
		}
	}

	async #unpack(s: MachineState, req: Request, url: URL): Promise<Response> {
		const q = url.searchParams;
		const root = resolveGuestPath(q.get("path") ?? "", s.machine.home);
		const gz = parseFormat(q.get("format"));
		const overwrite = queryBool(q, "overwrite", true);
		const makeParents = queryBool(q, "make_parents", true);
		if (makeParents) {
			await fsCall(() => fsp.mkdir(root, { recursive: true }));
		}
		const st = await fsCall(() => fsp.stat(root));
		if (!st.isDirectory()) {
			throw callError("not_directory", `${root} is not a directory`);
		}
		const spooled = join(s.spool, `archive-${randomUUID()}.tar`);
		try {
			const source =
				req.body === null
					? Readable.from([])
					: Readable.fromWeb(req.body as NodeReadableStream);
			try {
				if (gz) {
					await pipeline(source, createGunzip(), createWriteStream(spooled));
				} else {
					await pipeline(source, createWriteStream(spooled));
				}
			} catch (e) {
				throw callError("invalid_argument", `read archive: ${errorMessage(e)}`);
			}
			const entries = await readTarEntries(spooled);
			const result = await this.#checkEntries(entries, root, overwrite);
			if (result.entries > 0) await this.#extract(spooled, root);
			return Response.json({ path: root, ...result });
		} finally {
			await fsp.rm(spooled, { force: true });
		}
	}

	/** S3 §11.2 rules; the archive is extracted only if every entry passes. */
	async #checkEntries(
		entries: TarEntry[],
		root: string,
		overwrite: boolean,
	): Promise<{ entries: number; size: number }> {
		const archived = new Map<string, string>();
		let count = 0;
		let size = 0;
		for (const e of entries) {
			if (count >= this.#opts.archiveMaxEntries) {
				throw callError(
					"payload_too_large",
					`the archive has more than ${this.#opts.archiveMaxEntries} entries`,
				);
			}
			if (Buffer.byteLength(e.name) > this.#opts.archiveMaxPath) {
				throw callError(
					"payload_too_large",
					`a path is longer than ${this.#opts.archiveMaxPath} bytes`,
				);
			}
			const comps = entryComponents(e.name);
			if (comps.length === 0) continue; // the root directory itself
			const rel = comps.join("/");
			if (e.type === "3" || e.type === "4" || e.type === "6") {
				throw callError(
					"invalid_path",
					`${e.name}: devices and FIFOs are not allowed`,
				);
			}
			if (!["0", "7", "1", "2", "5"].includes(e.type)) {
				throw callError(
					"invalid_argument",
					`${e.name}: unsupported entry type ${JSON.stringify(e.type)}`,
				);
			}
			if (e.type === "1") {
				const target = entryComponents(e.linkname).join("/");
				const kind = archived.get(target);
				if (target === "" || (kind !== "0" && kind !== "7")) {
					throw callError(
						"invalid_path",
						`${e.name}: hard link to ${e.linkname} outside the archive`,
					);
				}
			}
			for (let i = 1; i < comps.length; i++) {
				const prefix = comps.slice(0, i).join("/");
				const kind = archived.get(prefix);
				const onDisk = await fsp.lstat(join(root, prefix)).catch(() => null);
				if (kind === "2" || (kind === undefined && onDisk?.isSymbolicLink())) {
					throw callError(
						"invalid_path",
						`${e.name}: passes through the symlink ${prefix}`,
					);
				}
			}
			const existing = await fsp.lstat(join(root, rel)).catch(() => null);
			if (existing !== null && !archived.has(rel)) {
				if (e.type === "5" && existing.isSymbolicLink()) {
					throw callError("invalid_path", `${e.name}: is a symlink on disk`);
				}
				if (e.type !== "5" && !overwrite) {
					throw callError(
						"already_exists",
						`${join(root, rel)} already exists`,
					);
				}
			}
			archived.set(rel, e.type);
			count++;
			if (e.type === "0" || e.type === "7") {
				size += e.size;
				if (size > this.#opts.archiveMaxBytes) {
					throw callError(
						"payload_too_large",
						`the archive unpacks to more than ${this.#opts.archiveMaxBytes} bytes`,
					);
				}
			}
		}
		return { entries: count, size };
	}

	#extract(file: string, root: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				"tar",
				["-x", "-p", "-f", file, "-C", root, "--no-same-owner"],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			this.#tars.add(child);
			let stderr = "";
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				this.#tars.delete(child);
				if (code === 0) resolve();
				else reject(callError("internal", `tar: ${stderr.trim()}`));
			});
		});
	}
}

// --- commands ---

class OutputBuffer {
	#chunks: { offset: number; data: Buffer }[] = [];
	availableFrom = 0;
	size = 0;
	end: number | null = null;

	append(data: Buffer, retain: number | null): void {
		if (data.length === 0) return;
		this.#chunks.push({ offset: this.size, data });
		this.size += data.length;
		if (retain !== null) this.evict(retain);
	}

	evict(retain: number): void {
		const from = Math.max(this.availableFrom, this.size - retain);
		if (from <= this.availableFrom) return;
		this.availableFrom = from;
		while (true) {
			const c = this.#chunks[0];
			if (c === undefined || c.offset >= from) break;
			if (c.offset + c.data.length <= from) {
				this.#chunks.shift();
			} else {
				this.#chunks[0] = {
					offset: from,
					data: c.data.subarray(from - c.offset),
				};
				break;
			}
		}
	}

	/** A copy of up to `max` bytes from `from` (availableFrom ≤ from < size). */
	read(from: number, max: number): Uint8Array {
		let lo = 0;
		let hi = this.#chunks.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.#chunks[mid]?.offset ?? 0) <= from) lo = mid;
			else hi = mid - 1;
		}
		const out = new Uint8Array(Math.min(max, this.size - from));
		let at = 0;
		for (let i = lo; at < out.length && i < this.#chunks.length; i++) {
			const c = this.#chunks[i] as { offset: number; data: Buffer };
			const start = Math.max(0, from + at - c.offset);
			const part = c.data.subarray(start, start + out.length - at);
			out.set(part, at);
			at += part.length;
		}
		return out;
	}

	info(): AgentStreamInfo {
		return {
			size: this.size,
			availableFrom: this.availableFrom,
			end: this.end,
		};
	}
}

class FakeCommand {
	readonly id: string;
	readonly spec: AgentCommandSpec;
	readonly specHash: string;
	readonly streams: AgentStream[];
	readonly out = new Map<AgentStream, OutputBuffer>();
	readonly lastSeq = new Map<string, number>();
	readonly sizes: { cols: number; rows: number }[] = [];
	readonly started: Promise<void>;
	readonly finished: Promise<void>;
	child: ChildProcess | null = null;
	pid: number | null = null;
	state: AgentCommandState = "starting";
	exit: AgentExitInfo | null = null;
	startedAt: Date | null = null;
	endedAt: Date | null = null;
	timedOut = false;

	readonly #retain: () => number | null;
	readonly #timers: NodeJS.Timeout[] = [];
	#tick = Promise.withResolvers<void>();
	#markStarted: () => void = () => {};
	#markFinished: () => void = () => {};
	#exitedWith: { code: number | null; signal: NodeJS.Signals | null } | null =
		null;

	constructor(
		id: string,
		spec: AgentCommandSpec,
		specHash: string,
		retain: () => number | null,
	) {
		this.id = id;
		this.spec = spec;
		this.specHash = specHash;
		this.#retain = retain;
		this.streams = spec.pty ? ["pty"] : ["stdout", "stderr"];
		for (const s of this.streams) this.out.set(s, new OutputBuffer());
		if (spec.pty) this.sizes.push({ cols: spec.pty.cols, rows: spec.pty.rows });
		this.started = new Promise((r) => {
			this.#markStarted = r;
		});
		this.finished = new Promise((r) => {
			this.#markFinished = r;
		});
	}

	get hasStdin(): boolean {
		return this.spec.stdin || this.spec.pty !== undefined;
	}

	buffer(s: AgentStream): OutputBuffer {
		return this.out.get(s) as OutputBuffer;
	}

	changed(): Promise<void> {
		return this.#tick.promise;
	}

	notify(): void {
		const t = this.#tick;
		this.#tick = Promise.withResolvers<void>();
		t.resolve();
	}

	addTimer(t: NodeJS.Timeout): void {
		t.unref();
		this.#timers.push(t);
	}

	clearTimers(): void {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers.length = 0;
	}

	#write(stream: AgentStream, data: Buffer): void {
		const name = this.spec.pty ? "pty" : stream;
		this.buffer(name).append(data, this.#retain());
		this.notify();
	}

	attachChild(child: ChildProcess, program: string): void {
		this.child = child;
		child.stdin?.on("error", () => {});
		child.stdout?.on("data", (b: Buffer) => this.#write("stdout", b));
		child.stderr?.on("data", (b: Buffer) => this.#write("stderr", b));
		child.once("spawn", () => {
			this.pid = child.pid ?? null;
			this.state = "running";
			this.startedAt = new Date();
			this.#markStarted();
		});
		child.once("error", (e) => {
			if (this.state === "starting")
				this.startFailed(`${program}: ${e.message}`);
		});
		child.once("exit", (code, signal) => {
			this.#exitedWith = { code, signal };
			// Leftovers may keep the pipes open; the main process decides the end.
			this.addTimer(
				setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					this.#finish();
				}, LEFTOVER_PIPE_MS),
			);
		});
		child.once("close", (code, signal) => {
			this.#exitedWith ??= { code, signal };
			this.#finish();
		});
	}

	startFailed(message: string): void {
		if (this.exit !== null) return;
		this.#write("stderr", Buffer.from(`${message}\n`));
		this.startedAt = new Date();
		this.#end({
			status: "exited",
			code: 127,
			signal: null,
			reason: "start_failed",
		});
		this.#markStarted();
	}

	#finish(): void {
		if (this.exit !== null || this.#exitedWith === null) return;
		const { code, signal } = this.#exitedWith;
		const signo = signal === null ? 0 : (osConstants.signals[signal] ?? 0);
		this.#end({
			status: signal === null ? "exited" : "killed",
			code: signal === null ? (code ?? 0) : 128 + signo,
			signal,
			reason: this.timedOut ? "timeout" : signal === null ? "none" : "signal",
		});
	}

	#end(exit: AgentExitInfo): void {
		this.clearTimers();
		this.exit = exit;
		this.state = "exited";
		this.endedAt = new Date();
		for (const b of this.out.values()) b.end = b.size;
		this.child = null;
		this.notify();
		this.#markFinished();
	}

	info(): AgentCommandInfo {
		const streams: AgentCommandInfo["streams"] = {};
		for (const s of this.streams) streams[s] = this.buffer(s).info();
		return {
			commandId: this.id,
			state: this.state,
			pid: this.pid,
			exit: this.exit === null ? null : { ...this.exit },
			streams,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
		};
	}
}

function killGroup(pid: number, sig: NodeJS.Signals | number): void {
	try {
		process.kill(-pid, sig);
	} catch {
		// The group is gone.
	}
}

function parseSignal(s: string): NodeJS.Signals {
	const signals = osConstants.signals as Record<string, number>;
	if (/^[0-9]+$/.test(s)) {
		const n = Number(s);
		const name = Object.keys(signals).find((k) => signals[k] === n);
		if (name !== undefined) return name as NodeJS.Signals;
	} else {
		const name = s.startsWith("SIG") ? s : `SIG${s}`;
		if (signals[name] !== undefined) return name as NodeJS.Signals;
	}
	throw callError("invalid_argument", `unknown signal ${JSON.stringify(s)}`);
}

function connectionReset(): Error {
	return Object.assign(new Error("fake agent: attach stream reset"), {
		code: "ECONNRESET",
	});
}

function commandExited(commandId: string): AgentCallError {
	return callError("command_exited", `command ${commandId} has exited`);
}

// --- errors ---

/** HTTP status of an agent code on `/files` (S3 §11.1, Connect mapping). */
const HTTP_STATUS: Record<string, number> = {
	path_not_found: 404,
	upload_not_found: 404,
	command_not_found: 404,
	not_found: 404,
	already_exists: 409,
	upload_offset_mismatch: 409,
	not_directory: 400,
	is_directory: 400,
	cross_device: 400,
	failed_precondition: 400,
	invalid_argument: 400,
	invalid_path: 400,
	permission_denied: 403,
	payload_too_large: 413,
	checksum_mismatch: 422,
	too_many_commands: 429,
	command_exited: 400,
	no_space: 507,
};

function callError(
	code: string,
	message: string,
	details: Record<string, unknown> = {},
	status?: number,
): AgentCallError {
	return new AgentCallError(
		code,
		message,
		details,
		status ?? HTTP_STATUS[code] ?? 500,
	);
}

const ERRNO_CODES: Record<string, string> = {
	ENOENT: "path_not_found",
	EEXIST: "already_exists",
	ENOTDIR: "not_directory",
	EISDIR: "is_directory",
	ENOSPC: "no_space",
	EDQUOT: "no_space",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	EXDEV: "cross_device",
	ENOTEMPTY: "failed_precondition",
};

function errnoOf(e: unknown): string | undefined {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** A filesystem error as the agent reports it. */
function fsError(e: unknown): AgentCallError {
	if (e instanceof AgentCallError) return e;
	const code = ERRNO_CODES[errnoOf(e) ?? ""] ?? "internal";
	return callError(code, errorMessage(e));
}

async function fsCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		throw fsError(e);
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function errorResponse(
	e: unknown,
	extra: Record<string, unknown> = {},
): Response {
	if (e instanceof AgentUnavailableError) throw e;
	const err = fsError(e);
	const headers: Record<string, string> = {};
	if (typeof err.details.offset === "number") {
		headers["Sbx-Upload-Offset"] = String(err.details.offset);
	}
	return Response.json(
		{ ...extra, code: err.code, message: err.message, retryable: false },
		{ status: err.status ?? 500, headers },
	);
}

function endpointNotFound(): Response {
	return Response.json(
		{ code: "not_found", message: "no such endpoint", retryable: false },
		{ status: 404 },
	);
}

function methodNotAllowed(allow: string): Response {
	return Response.json(
		{ code: "unimplemented", message: "method not allowed", retryable: false },
		{ status: 405, headers: { Allow: allow } },
	);
}

function uploadNotFound(id: string): AgentCallError {
	return callError(
		"upload_not_found",
		`upload ${JSON.stringify(id)} not found`,
	);
}

function offsetMismatch(want: number, got: number): AgentCallError {
	return callError(
		"upload_offset_mismatch",
		`offset ${got} does not match the upload size ${want}`,
		{ offset: want },
	);
}

function chunkTooLarge(max: number): AgentCallError {
	return callError("payload_too_large", `a chunk is at most ${max} bytes`);
}

// --- files helpers ---

/** S3 §11.1: "~", "~/x" and relative paths resolve against the home. */
function resolveGuestPath(p: string, home: string): string {
	if (p === "") throw callError("invalid_path", "path is empty");
	if (p.includes("\0"))
		throw callError("invalid_path", "path contains a NUL byte");
	if (p === "~") return home;
	if (p.startsWith("~/")) return resolvePath(home, p.slice(2));
	return resolvePath(home, p);
}

function statSyncOrNull(p: string): Stats | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

const myUid = process.getuid?.() ?? -1;
const myGid = process.getgid?.() ?? -1;
const myName = userInfo().username;

async function fileInfo(p: string, follow: boolean): Promise<AgentFileInfo> {
	const st = follow ? await fsp.stat(p) : await fsp.lstat(p);
	const symlink = st.isSymbolicLink();
	return {
		path: p,
		name: basename(p) || "/",
		type: st.isFile()
			? "file"
			: st.isDirectory()
				? "dir"
				: symlink
					? "symlink"
					: "other",
		size: st.size,
		mode: st.mode & 0o7777,
		owner: st.uid === myUid ? myName : String(st.uid),
		group: st.gid === myGid ? myName : String(st.gid),
		uid: st.uid,
		gid: st.gid,
		mtime: st.mtime,
		symlinkTarget: symlink ? await fsp.readlink(p) : "",
	};
}

/** Like the agent: follow a symlink at p, refuse a directory, make parents. */
async function prepareTarget(
	p: string,
	overwrite: boolean,
	makeParents: boolean,
): Promise<string> {
	const target = await fsp.realpath(p).catch(() => p);
	const st = await fsp.stat(target).catch((e: unknown) => {
		if (errnoOf(e) === "ENOENT") return null;
		throw fsError(e);
	});
	if (st?.isDirectory()) throw callError("is_directory", `${p} is a directory`);
	if (st !== null && !overwrite)
		throw callError("already_exists", `${p} already exists`);
	if (makeParents)
		await fsCall(() => fsp.mkdir(dirname(target), { recursive: true }));
	return target;
}

async function writeBody(
	req: Request,
	file: string,
	mode: number,
): Promise<void> {
	const source =
		req.body === null
			? Readable.from([])
			: Readable.fromWeb(req.body as NodeReadableStream);
	await pipeline(source, createWriteStream(file, { mode, flags: "wx" }));
}

/** The whole body, or null when it exceeds max bytes. */
async function readCapped(
	req: Request,
	max: number,
): Promise<Uint8Array | null> {
	if (req.body === null) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let size = 0;
	const reader = req.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

function jsonText(body: string): Response {
	return new Response(body, {
		headers: { "Content-Type": "application/json" },
	});
}

function nodeToWeb(r: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(r) as unknown as ReadableStream<Uint8Array>;
}

function parseRange(header: string, size: number): [number, number] | null {
	const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(header.trim());
	if (m === null) return null;
	const [, a = "", b = ""] = m;
	if (a === "") {
		const n = Number(b);
		if (b === "" || n === 0 || size === 0) return null;
		return [Math.max(0, size - n), size - 1];
	}
	const start = Number(a);
	if (start >= size) return null;
	const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
	return end < start ? null : [start, end];
}

function parseMode(s: string | null): number | undefined {
	if (s === null) return undefined;
	const t = s.replace(/^0[oO]/, "");
	if (!/^[0-7]{1,6}$/.test(t) || Number.parseInt(t, 8) > 0o7777) {
		throw callError(
			"invalid_argument",
			`mode ${JSON.stringify(s)} is not an octal mode`,
		);
	}
	return Number.parseInt(t, 8);
}

function queryBool(q: URLSearchParams, key: string, def: boolean): boolean {
	const v = q.get(key);
	if (v === null) return def;
	if (["1", "t", "T", "true", "TRUE", "True"].includes(v)) return true;
	if (["0", "f", "F", "false", "FALSE", "False"].includes(v)) return false;
	throw callError(
		"invalid_argument",
		`${key}=${JSON.stringify(v)} is not a boolean`,
	);
}

function parseFormat(f: string | null): boolean {
	if (f === null || f === "" || f === "tar") return false;
	if (f === "tar.gz") return true;
	throw callError(
		"invalid_argument",
		`format ${JSON.stringify(f)} is not tar or tar.gz`,
	);
}

/** Path components of a tar entry name; absolute or ".." → invalid_path. */
function entryComponents(name: string): string[] {
	if (name.startsWith("/")) {
		throw callError("invalid_path", `${name}: absolute paths are not allowed`);
	}
	const comps = name.split("/").filter((c) => c !== "" && c !== ".");
	if (comps.includes("..")) {
		throw callError("invalid_path", `${name}: ".." is not allowed`);
	}
	return comps;
}

function compareComponents(a: string[], b: string[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i] as string;
		const y = b[i] as string;
		if (x !== y) return x < y ? -1 : 1;
	}
	return a.length - b.length;
}

// --- tar headers ---

interface TarEntry {
	name: string;
	/** ustar typeflag ("0" for a NUL flag). */
	type: string;
	size: number;
	linkname: string;
}

/** The entries of a tar file (ustar, pax 'x' records, GNU long names). */
async function readTarEntries(file: string): Promise<TarEntry[]> {
	const fh = await fsp.open(file);
	try {
		const out: TarEntry[] = [];
		const h = Buffer.alloc(512);
		let pos = 0;
		let pax: Record<string, string> = {};
		let longName: string | undefined;
		let longLink: string | undefined;
		const readData = async (at: number, size: number) => {
			const b = Buffer.alloc(size);
			const { bytesRead } = await fh.read(b, 0, size, at);
			if (bytesRead < size)
				throw callError("invalid_argument", "read archive: unexpected EOF");
			return b;
		};
		for (;;) {
			const { bytesRead } = await fh.read(h, 0, 512, pos);
			if (bytesRead === 0) break;
			if (bytesRead < 512)
				throw callError("invalid_argument", "read archive: unexpected EOF");
			if (h.every((b) => b === 0)) break;
			if (!checksumOk(h))
				throw callError("invalid_argument", "read archive: invalid tar header");
			const flag = h[156] === 0 ? "0" : String.fromCharCode(h[156] as number);
			let size = tarNumber(h.subarray(124, 136));
			const dataAt = pos + 512;
			if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
				const data = await readData(dataAt, size);
				if (flag === "x") pax = parsePax(data);
				if (flag === "L") longName = cString(data);
				if (flag === "K") longLink = cString(data);
				pos = dataAt + Math.ceil(size / 512) * 512;
				continue;
			}
			if (pax.size !== undefined) size = Number(pax.size);
			const ustar = h.subarray(257, 262).toString() === "ustar";
			const base = cString(h.subarray(0, 100));
			const prefix = ustar ? cString(h.subarray(345, 500)) : "";
			const name =
				pax.path ?? longName ?? (prefix ? `${prefix}/${base}` : base);
			const linkname =
				pax.linkpath ?? longLink ?? cString(h.subarray(157, 257));
			pax = {};
			longName = undefined;
			longLink = undefined;
			// Hard links, symlinks, directories and devices carry no data.
			const dataSize = "123456".includes(flag) ? 0 : size;
			pos = dataAt + Math.ceil(dataSize / 512) * 512;
			if (flag === "V") continue;
			out.push({ name, type: flag, size, linkname });
		}
		return out;
	} finally {
		await fh.close();
	}
}

function checksumOk(h: Buffer): boolean {
	let sum = 0;
	for (let i = 0; i < 512; i++)
		sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
	return tarNumber(h.subarray(148, 156)) === sum;
}

/** An octal field, or base-256 when the high bit is set. */
function tarNumber(b: Buffer): number {
	if (((b[0] as number) & 0x80) !== 0) {
		let n = (b[0] as number) & 0x7f;
		for (let i = 1; i < b.length; i++) n = n * 256 + (b[i] as number);
		return n;
	}
	const s = b
		.toString("latin1")
		.replace(/[\0 ]+$/g, "")
		.trim();
	return s === "" ? 0 : Number.parseInt(s, 8);
}

function cString(b: Buffer): string {
	const nul = b.indexOf(0);
	return b.subarray(0, nul < 0 ? b.length : nul).toString("utf8");
}

/** pax records "<len> <key>=<value>\n". */
function parsePax(b: Buffer): Record<string, string> {
	const out: Record<string, string> = {};
	let i = 0;
	while (i < b.length) {
		const sp = b.indexOf(0x20, i);
		if (sp < 0) break;
		const len = Number(b.subarray(i, sp).toString());
		if (!Number.isSafeInteger(len) || len <= 0) break;
		const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
		const eq = rec.indexOf("=");
		if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
		i += len;
	}
	return out;
}

// --- misc ---

function sha256Hex(b: string | Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}

/** JSON with sorted object keys (the spec hash of Start). */
function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}
