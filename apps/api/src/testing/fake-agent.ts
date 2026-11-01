// FakeAgent: an in-process AgentApi for api, SDK and CLI tests. It follows
// the S3 contract (§9–§13) closely enough that code written against it works
// with the real agent:
// - each machine has a guest root directory that stands for "/" of the VM;
//   the home of the user is /home/user in it. Files calls (Filesystem RPC
//   and `/files*`, fake-agent-files.ts) never leave the root;
// - commands are real processes (`/bin/bash -lc <shell>` or argv) in their
//   own process group, cwd mapped into the guest root; output is kept in
//   memory with stable offsets; Start is idempotent by commandId. Processes
//   are not confined: they see host paths (HOME is the host home dir);
// - a PTY command is the same process without a terminal: stdout and stderr
//   share one pipe into the single stream "pty", `update` records sizes;
// - attach: truncated, heartbeat, exit only after all output (S2 §9.1);
// - faults: failNextAttach, failNextStart, setUnavailable, retention,
//   chunkSize, writePastEnd (leftovers writing past the end of a stream).
// Call close() (afterAll): it kills every process group and removes the
// temporary directories.
import { type ChildProcess, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentFetchInit,
	AgentOutdatedError,
	AgentUnavailableError,
} from "@umiak/agent-client";
import type { AgentCallError } from "../agent/errors.ts";
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
	type DesktopMethod,
} from "../agent/types.ts";
import {
	callError,
	errorMessage,
	type FilesLimits,
	MachineFiles,
	sha256Hex,
} from "./fake-agent-files.ts";

export { GUEST_HOME } from "./fake-agent-files.ts";

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
	/** Host directory that is "/" of the guest. */
	readonly root: string;
	/** Host directory of /home/user (the default user's home). */
	readonly home: string;
	capabilities: string[];
	/** What `listPorts` returns. */
	ports: AgentPort[] = [];
	/** Sandbox env (`updateEnv`), applied to new commands. */
	env: Record<string, string> = {};
	/** `updateSecrets`: applied to new commands; files are kept here only. */
	secretEnv: Record<string, string> = {};
	secretFiles: AgentSecretFile[] = [];

	constructor(id: string, root: string, home: string, capabilities: string[]) {
		this.id = id;
		this.root = root;
		this.home = home;
		this.capabilities = capabilities;
	}
}

interface MachineState {
	machine: FakeMachine;
	files: MachineFiles;
	unavailable: boolean;
	failNext: { afterBytes: number; kind: FakeAttachFailure } | null;
	/** failNextAttach failures that were thrown. */
	attachFailures: number;
	failStart: { code: string; launched: boolean } | null;
	commands: Map<string, FakeCommand>;
	/** Process launches by commandId. */
	starts: Map<string, number>;
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

/**
 * After the main process exits, its pipes may still deliver its last
 * output, or leftovers may hold them: the end comes after this much
 * silence, and at the latest LEFTOVER_MAX_WAIT_MS after the exit (chatty
 * leftovers). Later leftover output is dropped.
 */
const LEFTOVER_SILENCE_MS = 100;
/** SIGTERM → SIGKILL of a timed-out command (the shim's default kill grace). */
const TIMEOUT_KILL_GRACE_MS = 10_000;
const LEFTOVER_MAX_WAIT_MS = 1000;

export class FakeAgent implements AgentApi {
	readonly desktopClipboard = new Map<string, string>();
	async desktopCall(
		machineId: string,
		method: DesktopMethod,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		this.#reach(machineId);
		const screen = { width: 1920, height: 1080 },
			cursor = { x: 10, y: 20 };
		const image = {
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNioAAAAASUVORK5CYII=",
			contentType: "image/png",
			screen,
			image: { width: 1, height: 1 },
			cursor,
			scale: 1 / 1920,
		};
		switch (method) {
			case "status":
				return {
					state: "ready",
					reason: "",
					screen,
					cursor,
					running: false,
					desktopStreams: 0,
				};
			case "open":
				return { hostId: "host", appId: "desktop" };
			case "screenshot":
				return image;
			case "act":
				return {
					completed: (body.actions as unknown[]).length,
					screen,
					cursor,
					...(body.screenshot ? { screenshot: image } : {}),
				};
			case "getClipboard": {
				const text = this.desktopClipboard.get(machineId) ?? "";
				return { text, hasText: text !== "" };
			}
			case "setClipboard":
				this.desktopClipboard.set(machineId, String(body.text));
				return {};
			default:
				return {};
		}
	}

	/** Max bytes of one attach data event; 1 for UTF-8 boundary tests. */
	chunkSize: number;
	/** Silence before an attach heartbeat. */
	heartbeatMs: number;

	readonly #maxRunning: number;
	readonly #limits: FilesLimits;
	readonly #capabilities: string[];
	readonly #machines = new Map<string, MachineState>();
	readonly #tars = new Set<ChildProcess>();
	#retain: number | null = null;
	#root: string | null = null;
	#closed = false;

	static readonly #live = new Set<FakeAgent>();
	static {
		// Safety net for a test run that ends without close().
		process.once("exit", () => {
			for (const f of FakeAgent.#live) f.#killAll();
			for (const f of FakeAgent.#live) f.#removeRoot();
		});
	}

	constructor(opts: FakeAgentOptions = {}) {
		this.chunkSize = opts.chunkSize ?? DEFAULTS.chunkSize;
		this.heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs;
		this.#capabilities = opts.capabilities ?? [...AGENT_CAPABILITIES];
		this.#maxRunning = opts.maxRunningCommands ?? DEFAULTS.maxRunningCommands;
		this.#limits = {
			maxChunkBytes: opts.maxChunkBytes ?? DEFAULTS.maxChunkBytes,
			archiveMaxEntries: opts.archiveMaxEntries ?? DEFAULTS.archiveMaxEntries,
			archiveMaxBytes: opts.archiveMaxBytes ?? DEFAULTS.archiveMaxBytes,
			archiveMaxPath: opts.archiveMaxPath ?? DEFAULTS.archiveMaxPath,
		};
		FakeAgent.#live.add(this);
	}

	// --- test controls ---

	/** The machine, created with an empty guest root on first use. */
	machine(machineId: string): FakeMachine {
		return this.#state(machineId).machine;
	}

	/**
	 * How many times the process of `commandId` was launched on the machine,
	 * or on all machines without `machineId`.
	 */
	startCount(commandId: string, machineId?: string): number {
		let n = 0;
		for (const [id, s] of this.#machines) {
			if (machineId === undefined || id === machineId) {
				n += s.starts.get(commandId) ?? 0;
			}
		}
		return n;
	}

	/** Process launches of every command, on the machine or on all machines. */
	totalStarts(machineId?: string): number {
		let n = 0;
		for (const [id, s] of this.#machines) {
			if (machineId !== undefined && id !== machineId) continue;
			for (const c of s.starts.values()) n += c;
		}
		return n;
	}

	/**
	 * How many failNextAttach failures were thrown on the machine (an armed
	 * failure counts only once an attach reached its byte count).
	 */
	attachFailures(machineId: string): number {
		return this.#machines.get(machineId)?.attachFailures ?? 0;
	}

	/** PTY sizes of a command: the one from its spec, then each `update`. */
	ptySizes(
		commandId: string,
		machineId?: string,
	): { cols: number; rows: number }[] {
		for (const [id, s] of this.#machines) {
			if (machineId !== undefined && id !== machineId) continue;
			const c = s.commands.get(commandId);
			if (c !== undefined) return [...c.sizes];
		}
		return [];
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

	/**
	 * The next Start of a new command on the machine fails with the agent
	 * error `code` (an AgentCallError, as ConnectAgentApi maps it; `unknown`
	 * stands for a Connect Unknown). With `launched` the process is started
	 * first: the real agent can fail after the launch (a store error in
	 * markRunning, a systemd query in settle; S3 §9.2), so the process runs
	 * and a repeat with the same commandId finds it.
	 */
	failNextStart(
		machineId: string,
		code: string,
		opts: { launched?: boolean } = {},
	): void {
		this.#state(machineId).failStart = {
			code,
			launched: opts.launched ?? false,
		};
	}

	/**
	 * Leftovers of an exited command write `data` to `stream` past its end
	 * (S3 §10, Linux): the size of the stream grows, its end stays, and
	 * attach never sends bytes past the end.
	 */
	writePastEnd(
		commandId: string,
		stream: AgentStream,
		data: string | Uint8Array,
	): void {
		const cmd = this.#allCommands().find((c) => c.id === commandId);
		if (cmd === undefined) throw new Error(`no command ${commandId}`);
		if (cmd.exit === null) throw new Error(`command ${commandId} runs`);
		cmd.buffer(stream).append(Buffer.from(data), this.#retain);
		cmd.notify();
	}

	/**
	 * Marks the command's output as cut by the shim (`output_truncated`,
	 * e.g. "disk_full"): its exit event and Get carry the reason.
	 */
	truncateOutput(commandId: string, reason: string): void {
		const cmd = this.#allCommands().find((c) => c.id === commandId);
		if (cmd === undefined) throw new Error(`no command ${commandId}`);
		cmd.outputTruncated = reason;
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
		for (const c of this.#allCommands()) {
			for (const b of c.out.values()) b.evict(bytes);
		}
	}

	/** Kills every process group, removes the temporary directories. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#killAll();
		const live = this.#allCommands().filter((c) => c.exit === null);
		await Promise.race([
			Promise.all(live.map((c) => c.finished)),
			new Promise((r) => setTimeout(r, 5000).unref()),
		]);
		for (const c of this.#allCommands()) c.clearTimers(true);
		this.#removeRoot();
		FakeAgent.#live.delete(this);
	}

	#allCommands(): FakeCommand[] {
		return [...this.#machines.values()].flatMap((s) => [
			...s.commands.values(),
		]);
	}

	#killAll(): void {
		for (const c of this.#allCommands()) {
			// Exited commands too: their leftovers share the process group.
			if (c.pid !== null) killGroup(c.pid, "SIGKILL");
		}
		for (const t of this.#tars) t.kill("SIGKILL");
	}

	#removeRoot(): void {
		if (this.#root !== null) {
			rmSync(this.#root, { recursive: true, force: true });
		}
		this.#root = null;
	}

	#state(machineId: string): MachineState {
		let s = this.#machines.get(machineId);
		if (s === undefined) {
			if (this.#closed) throw new Error("FakeAgent is closed");
			this.#root ??= realpathSync(
				mkdtempSync(join(tmpdir(), "umiak-fake-agent-")),
			);
			const dir = join(this.#root, `m${this.#machines.size}`);
			mkdirSync(dir);
			const files = new MachineFiles(dir, this.#limits, this.#tars);
			s = {
				machine: new FakeMachine(machineId, files.root, files.home, [
					...this.#capabilities,
				]),
				files,
				unavailable: false,
				failNext: null,
				attachFailures: 0,
				failStart: null,
				commands: new Map(),
				starts: new Map(),
			};
			this.#machines.set(machineId, s);
		}
		return s;
	}

	/** The machine of an RPC or HTTP call: unavailable → AgentUnavailableError. */
	#reach(machineId: string): MachineState {
		const s = this.#state(machineId);
		if (s.unavailable || this.#closed) {
			throw new AgentUnavailableError(machineId);
		}
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
		if (running.length >= this.#maxRunning) {
			throw callError(
				"too_many_commands",
				`at most ${this.#maxRunning} commands may run`,
			);
		}
		const fault = s.failStart;
		s.failStart = null;
		const injected = () =>
			callError(
				fault?.code ?? "internal",
				"fake agent: injected Start failure",
			);
		if (fault !== null && !fault.launched) throw injected();
		// Registered before any await: a concurrent Start finds it.
		const cmd = new FakeCommand(req.commandId, spec, hash, () => this.#retain);
		s.commands.set(req.commandId, cmd);
		s.starts.set(req.commandId, (s.starts.get(req.commandId) ?? 0) + 1);
		this.#launch(s, cmd);
		await cmd.started;
		if (fault !== null) throw injected();
		return { command: cmd.info(), created: true };
	}

	#launch(s: MachineState, cmd: FakeCommand): void {
		const spec = cmd.spec;
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
			HOME: s.machine.home,
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
			const cwd = s.files.resolve(spec.cwd === "" ? "~" : spec.cwd);
			if (!statSync(cwd.host, { throwIfNoEntry: false })?.isDirectory()) {
				throw new Error(`cwd ${cwd.guest}: no such directory`);
			}
			child = spawn(program, args, {
				cwd: cwd.host,
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
			// Like the shim: SIGTERM, then SIGKILL after the kill grace.
			cmd.addTimer(
				setTimeout(() => {
					cmd.timedOut = true;
					const pid = cmd.pid;
					if (pid === null) return;
					killGroup(pid, "SIGTERM");
					cmd.addGraceTimer(
						setTimeout(() => killGroup(pid, "SIGKILL"), TIMEOUT_KILL_GRACE_MS),
					);
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
		const failure = () => {
			s.attachFailures += 1;
			return fail?.kind === "unavailable"
				? new AgentUnavailableError(machineId)
				: connectionReset();
		};
		const streams = cmd.streams;
		const requested: Record<AgentStream, number> = {
			stdout: req.stdoutOffset,
			stderr: req.stderrOffset,
			pty: req.ptyOffset,
		};
		// Bytes past the end of an exited command (leftovers) are never sent.
		const limit = (b: OutputBuffer) =>
			cmd.exit !== null && b.end !== null ? Math.min(b.size, b.end) : b.size;
		const pos = new Map<AgentStream, number>();
		for (const name of streams) {
			const b = cmd.buffer(name);
			pos.set(
				name,
				req.tailBytes
					? Math.max(b.availableFrom, limit(b) - req.tailBytes)
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
				if (p < limit(b)) {
					let n = Math.min(Math.max(1, this.chunkSize), limit(b) - p);
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
				streams.every((n) => (pos.get(n) ?? 0) >= limit(cmd.buffer(n)))
			) {
				const end = (n: AgentStream) => cmd.out.get(n)?.end ?? 0;
				yield {
					type: "exit",
					...exit,
					stdoutEnd: end("stdout"),
					stderrEnd: end("stderr"),
					ptyEnd: end("pty"),
					endedAt: cmd.endedAt,
					outputTruncated: cmd.outputTruncated,
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
		// The shim's seq table: an unknown session has last seq 0.
		const last = cmd.lastSeq.get(req.inputSessionId) ?? 0;
		if (req.seq <= last) return { applied: false };
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
		// SIGKILL is cgroup.kill: it also reaches leftovers of an exited command.
		if (cmd.pid !== null && (cmd.exit === null || sig === "SIGKILL")) {
			killGroup(cmd.pid, sig);
		}
		return cmd.info();
	}

	async kill(
		machineId: string,
		req: AgentKillRequest,
	): Promise<AgentCommandInfo> {
		const cmd = this.#command(this.#reach(machineId), req.commandId);
		const pid = cmd.pid;
		if (pid !== null) {
			if (cmd.exit !== null) {
				// Only leftovers remain (S3 §9.5): cgroup.kill.
				killGroup(pid, "SIGKILL");
			} else {
				killGroup(pid, "SIGTERM");
				// Kept past the exit: leftovers that ignore SIGTERM get it too
				// (cgroup.kill after the grace, S3 §9.5).
				cmd.addGraceTimer(
					setTimeout(() => killGroup(pid, "SIGKILL"), req.graceMs ?? 10_000),
				);
			}
		}
		return cmd.info();
	}

	async get(machineId: string, commandId: string): Promise<AgentCommandInfo> {
		return this.#command(this.#reach(machineId), commandId).info();
	}

	// --- Filesystem ---

	async stat(machineId: string, req: AgentStatRequest): Promise<AgentFileInfo> {
		return this.#reach(machineId).files.stat(req);
	}

	async list(
		machineId: string,
		req: AgentListRequest,
	): Promise<AgentListResult> {
		return this.#reach(machineId).files.list(req);
	}

	async makeDir(
		machineId: string,
		req: AgentMakeDirRequest,
	): Promise<AgentMakeDirResult> {
		return this.#reach(machineId).files.makeDir(req);
	}

	async move(machineId: string, req: AgentMoveRequest): Promise<AgentFileInfo> {
		return this.#reach(machineId).files.move(req);
	}

	async chmod(
		machineId: string,
		req: AgentChmodRequest,
	): Promise<AgentFileInfo> {
		return this.#reach(machineId).files.chmod(req);
	}

	async remove(
		machineId: string,
		req: AgentRemoveRequest,
	): Promise<{ existed: boolean }> {
		return this.#reach(machineId).files.remove(req);
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
		return this.#reach(machineId).files.serve(path, init);
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
	/** Set by FakeAgent.truncateOutput (the shim dropped output). */
	outputTruncated: string | null = null;

	readonly #retain: () => number | null;
	readonly #timers = new Set<NodeJS.Timeout>();
	/** Kill grace timers: they outlive the main process. */
	readonly #graceTimers = new Set<NodeJS.Timeout>();
	#tick = Promise.withResolvers<void>();
	#markStarted: () => void = () => {};
	#markFinished: () => void = () => {};
	#exitedWith: { code: number | null; signal: NodeJS.Signals | null } | null =
		null;
	#silence: NodeJS.Timeout | null = null;
	/** When the main process exited (Date.now()). */
	#exitedAt = 0;

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
		this.#timers.add(t);
	}

	addGraceTimer(t: NodeJS.Timeout): void {
		t.unref();
		this.#graceTimers.add(t);
	}

	/** Timers of the running command; with `all` also the Kill grace timers. */
	clearTimers(all = false): void {
		for (const t of this.#timers) clearTimeout(t);
		this.#timers.clear();
		if (all) {
			for (const t of this.#graceTimers) clearTimeout(t);
			this.#graceTimers.clear();
		}
		if (this.#silence !== null) clearTimeout(this.#silence);
		this.#silence = null;
	}

	#write(stream: AgentStream, data: Buffer): void {
		if (this.exit !== null) return; // leftover output after the end
		const name = this.spec.pty ? "pty" : stream;
		this.buffer(name).append(data, this.#retain());
		this.notify();
		if (this.#exitedWith !== null) this.#armSilence();
	}

	/**
	 * (Re)starts the wait for silence after the main process exited, never
	 * past LEFTOVER_MAX_WAIT_MS after the exit.
	 */
	#armSilence(): void {
		if (this.#silence !== null) clearTimeout(this.#silence);
		const child = this.child;
		const left = this.#exitedAt + LEFTOVER_MAX_WAIT_MS - Date.now();
		this.#silence = setTimeout(
			() => {
				child?.stdout?.destroy();
				child?.stderr?.destroy();
				this.#finish();
			},
			Math.max(0, Math.min(LEFTOVER_SILENCE_MS, left)),
		);
		this.#silence.unref();
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
			if (this.state === "starting") {
				this.startFailed(`${program}: ${e.message}`);
			}
		});
		child.once("exit", (code, signal) => {
			this.#exitedWith = { code, signal };
			this.#exitedAt = Date.now();
			this.#armSilence();
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
		const signo = signal === null ? 0 : (LINUX_SIGNALS[signal] ?? 0);
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
			outputTruncated: this.outputTruncated,
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

/** Signal numbers of Linux (the guest), not of the host running the fake. */
const LINUX_SIGNALS: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
	SIGCHLD: 17,
	SIGCONT: 18,
	SIGSTOP: 19,
	SIGTSTP: 20,
	SIGTTIN: 21,
	SIGTTOU: 22,
	SIGURG: 23,
	SIGXCPU: 24,
	SIGXFSZ: 25,
	SIGVTALRM: 26,
	SIGPROF: 27,
	SIGWINCH: 28,
	SIGIO: 29,
	SIGSYS: 31,
};

/** A signal name or Linux number → the name (delivered by name on the host). */
function parseSignal(s: string): NodeJS.Signals {
	const host = osConstants.signals as Record<string, number>;
	if (/^[0-9]+$/.test(s)) {
		const n = Number(s);
		const name = Object.keys(LINUX_SIGNALS).find((k) => LINUX_SIGNALS[k] === n);
		if (name !== undefined && host[name] !== undefined) {
			return name as NodeJS.Signals;
		}
	} else {
		const name = s.startsWith("SIG") ? s : `SIG${s}`;
		if (LINUX_SIGNALS[name] !== undefined && host[name] !== undefined) {
			return name as NodeJS.Signals;
		}
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
