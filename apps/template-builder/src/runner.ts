import {
	type ExecResult,
	PveApiError,
	type PveClient,
	Qga,
	QgaExecStatusLostError,
	QgaTimeoutError,
} from "@sbx/pve";

// Build steps inside the build VM through the QEMU guest agent (spec S5 section 7.2 steps 5-6)

/** Guest access the runner needs; tests use a fake, `pveGuestIo` talks to Proxmox. */
export interface GuestIo {
	exec(
		cmd: string[],
		o?: { input?: string; timeoutMs?: number },
	): Promise<ExecResult>;
	/** Up to `count` bytes of a guest file from `offset`; a missing file reads as empty. */
	readFile(path: string, offset: number, count: number): Promise<Buffer>;
	ping(): Promise<boolean>;
}

export class StepFailedError extends Error {
	readonly step: string;
	readonly exitStatus: number;
	readonly tail: string[];
	constructor(
		step: string,
		exitStatus: number,
		tail: string[],
		reason?: string,
	) {
		super(`step ${step} failed: ${reason ?? `exit status ${exitStatus}`}`);
		this.name = "StepFailedError";
		this.step = step;
		this.exitStatus = exitStatus;
		this.tail = tail;
	}
}

export class StepTimeoutError extends Error {
	readonly step: string;
	readonly tail: string[];
	/** Last transient error seen while polling, if any. */
	readonly lastError: unknown;
	constructor(
		step: string,
		timeoutMs: number,
		tail: string[],
		lastError?: unknown,
	) {
		super(
			`step ${step} did not finish within ${timeoutMs} ms${
				lastError === undefined ? "" : `; last error: ${errorText(lastError)}`
			}`,
			lastError === undefined ? undefined : { cause: lastError },
		);
		this.name = "StepTimeoutError";
		this.lastError = lastError;
		this.step = step;
		this.tail = tail;
	}
}

const LOG_DIR = "/var/log/sbx-build";
const SEED_DIR = "/mnt/seed";
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const STEP_NAME_RE = /^[a-z0-9-]+$/;
const TAIL_LINES = 200;
/** Per file-read call; the Proxmox limit is 16 MiB. */
const READ_CHUNK = 1024 * 1024;
const DEFAULT_STEP_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_POLL_MS = 2000;
const START_CHECK_MS = 10_000;
const DEFAULT_REBOOT_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** File-read errors for a path that does not exist (the guest agent reports the OS error). */
const NO_SUCH_FILE_RE = /no such file|ENOENT/i;

export function pveGuestIo(
	api: PveClient,
	node: string,
	vmid: number,
): GuestIo {
	const qga = new Qga(api, node);
	return {
		exec: (cmd, o) => qga.exec(vmid, cmd, o),
		ping: () => qga.ping(vmid),
		async readFile(path, offset, count) {
			let r: { content?: string; "bytes-read"?: number };
			try {
				// decode=0: content stays base64, so binary and split UTF-8 bytes survive the JSON.
				r = await api.get(`/nodes/${node}/qemu/${vmid}/agent/file-read`, {
					file: path,
					offset,
					count,
					decode: false,
				});
			} catch (err) {
				if (err instanceof PveApiError && NO_SUCH_FILE_RE.test(err.message))
					return Buffer.alloc(0);
				throw err;
			}
			const buf = Buffer.from(r.content ?? "", "base64");
			const n = r["bytes-read"];
			return typeof n === "number" && n < buf.length ? buf.subarray(0, n) : buf;
		},
	};
}

const NETWORK_ERROR_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
]);
const NETWORK_ERROR_RE =
	/socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN/;

/** Connection-level failure between us and Proxmox (not an HTTP answer from it). */
function isNetworkError(err: unknown): boolean {
	if (!(err instanceof Error) || err instanceof PveApiError) return false;
	for (const e of [err, err.cause]) {
		const code = (e as { code?: unknown } | undefined)?.code;
		if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return true;
	}
	return NETWORK_ERROR_RE.test(err.message);
}

/**
 * Errors that only mean the guest agent or the connection did not answer; an idempotent call can
 * be repeated.
 */
function isTransient(err: unknown): boolean {
	if (err instanceof QgaTimeoutError || err instanceof QgaExecStatusLostError)
		return true;
	if (err instanceof PveApiError)
		return /guest agent is not running|got timeout/i.test(err.message);
	// Qga.exec gives up with a plain Error.
	if (err instanceof Error && /guest exec .* timed out/.test(err.message))
		return true;
	return isNetworkError(err);
}

/** PveApi gave up on a request that got no answer in time (plain Error, see pve-api.ts). */
const CLIENT_TIMEOUT_RE = /^(GET|POST|PUT|DELETE) \S+: timeout$/;

/**
 * Transient for idempotent calls only (polls, checks): also a client-side timeout and a 502/504
 * from a proxy, where the request may have been executed. Never used for the systemd-run start.
 */
function isTransientPoll(err: unknown): boolean {
	if (isTransient(err)) return true;
	if (err instanceof PveApiError)
		return err.status === 502 || err.status === 504;
	return err instanceof Error && CLIENT_TIMEOUT_RE.test(err.message);
}

/** Reports each distinct transient error message once through `log`. */
function transientNotes(log: (text: string) => void): (err: unknown) => void {
	const seen = new Set<string>();
	return (err) => {
		const msg = errorText(err);
		if (seen.has(msg)) return;
		seen.add(msg);
		log(`[sbx-tpl] transient error, retrying: ${msg}\n`);
	};
}

/** Repeats an idempotent call on transient errors until `deadline`, then rethrows the last one. */
async function retryTransient<T>(
	fn: () => Promise<T>,
	deadline: number,
	delayMs: number,
	note: (err: unknown) => void,
): Promise<T> {
	for (;;) {
		try {
			return await fn();
		} catch (err) {
			if (!isTransientPoll(err) || Date.now() >= deadline) throw err;
			note(err);
			await sleep(delayMs);
		}
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function parseShow(stdout: string): Record<string, string> {
	const props: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
	}
	return props;
}

/** Keeps the last `max` complete lines of a text stream. */
class Tail {
	readonly #max: number;
	#lines: string[] = [];
	#partial = "";

	constructor(max: number) {
		this.#max = max;
	}

	push(text: string): void {
		const parts = (this.#partial + text).split("\n");
		this.#partial = parts.pop() ?? "";
		// Only the last `max` lines can survive; a big chunk must not be spread into arguments.
		for (const line of parts.length > this.#max
			? parts.slice(-this.#max)
			: parts)
			this.#lines.push(line);
		if (this.#lines.length > this.#max)
			this.#lines = this.#lines.slice(-this.#max);
	}

	lines(): string[] {
		const all = this.#partial ? [...this.#lines, this.#partial] : this.#lines;
		return all.slice(-this.#max);
	}
}

/** Stale files of an earlier attempt must not be mistaken for this run; the name is `$1`, not script text. */
const PREPARE_SCRIPT =
	'set -eu; mkdir -p /var/log/sbx-build; rm -f "/var/log/sbx-build/$1.rc" "/var/log/sbx-build/$1.log"';

export interface RunStepOptions {
	/** Step name, `[a-z0-9-]+`. */
	name: string;
	/** Absolute guest path of the step script, run as `bash <script>`. */
	script: string;
	/** Receives decoded log text as it grows. */
	log: (chunk: string) => void;
	pollMs?: number;
	timeoutMs?: number;
	/** How long to re-check the unit after an ambiguous start error (default 10 s). */
	startCheckMs?: number;
}

/**
 * Runs one build step as a transient systemd unit and follows its log by byte offset, so a long
 * step never depends on a QGA exec timeout. The exit status comes from `<name>.rc`, written by
 * ExecStopPost: with `--collect` the unit is gone as soon as it stops.
 */
export async function runStep(
	io: GuestIo,
	o: RunStepOptions,
): Promise<{ exitStatus: number; tail: string[] }> {
	const { name } = o;
	if (!STEP_NAME_RE.test(name)) throw new Error(`invalid step name "${name}"`);
	const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
	const timeoutMs = o.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const unit = `sbx-build-${name}`;
	const logPath = `${LOG_DIR}/${name}.log`;
	const rcPath = `${LOG_DIR}/${name}.rc`;
	const note = transientNotes(o.log);

	// Idempotent, so a lost reply is simply repeated.
	const prep = await retryTransient(
		() => io.exec(["bash", "-c", PREPARE_SCRIPT, "sbx-prep", name]),
		deadline,
		pollMs,
		note,
	);
	if (prep.exitCode !== 0)
		throw new Error(
			`step ${name}: preparing ${LOG_DIR} failed: ${prep.stderr.trim()}`,
		);

	// systemd expands $VAR in command lines itself, and EXIT_STATUS exists only in the environment
	// of the ExecStopPost process. `$$` makes systemd pass a literal `$` to sh, which then expands
	// $EXIT_STATUS. The argv element is handed to systemd-run as is (no shell on our side).
	const stopPost = `echo "$$EXIT_STATUS" > ${rcPath}`;
	const start = [
		"systemd-run",
		`--unit=${unit}`,
		"--collect",
		`--property=StandardOutput=append:${logPath}`,
		`--property=StandardError=append:${logPath}`,
		`--property=WorkingDirectory=${SEED_DIR}/build`,
		`--property=ExecStopPost=/bin/sh -c '${stopPost}'`,
		"--",
		"bash",
		o.script,
	];
	try {
		const r = await io.exec(start);
		if (r.exitCode !== 0)
			throw new Error(
				`step ${name}: systemd-run failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
			);
	} catch (err) {
		if (!isTransient(err)) throw err;
		// The command may have reached the guest, so it is never sent again blindly.
		const check = {
			unit,
			files: [rcPath, logPath],
			deadline,
			windowMs: o.startCheckMs ?? START_CHECK_MS,
			intervalMs: pollMs,
		};
		if (!(await unitStarted(io, name, check)))
			throw new Error(`step ${name}: unit did not start: ${errorText(err)}`, {
				cause: err,
			});
	}

	const decoder = new TextDecoder("utf-8");
	const tail = new Tail(TAIL_LINES);
	let offset = 0;
	const feed = (text: string) => {
		if (!text) return;
		tail.push(text);
		o.log(text);
	};
	// While the unit runs a short read ends the poll; after it stopped, read until an empty read.
	const drain = async (untilEmpty: boolean) => {
		for (;;) {
			const buf = await io.readFile(logPath, offset, READ_CHUNK);
			offset += buf.length;
			feed(decoder.decode(buf, { stream: true }));
			if (buf.length === 0 || (!untilEmpty && buf.length < READ_CHUNK)) return;
		}
	};

	// One poll: state first, then the log, so a step seen as finished has its whole log drained.
	const poll = async (): Promise<string | undefined> => {
		const show = await io.exec([
			"systemctl",
			"show",
			"-p",
			"ActiveState,Result,ExecMainStatus",
			unit,
		]);
		const state = parseShow(show.stdout).ActiveState;
		// A collected unit reads as inactive.
		const finished = state === "inactive" || state === "failed";
		await drain(finished);
		if (!finished) return undefined;
		return (await io.readFile(rcPath, 0, 64)).toString("utf8");
	};

	let rc: string | undefined;
	let lastError: unknown;
	for (;;) {
		try {
			rc = await poll();
		} catch (err) {
			if (!isTransientPoll(err)) throw err;
			note(err);
			lastError = err;
		}
		if (rc !== undefined) break;
		if (Date.now() >= deadline) {
			feed(decoder.decode());
			throw new StepTimeoutError(name, timeoutMs, tail.lines(), lastError);
		}
		await sleep(pollMs);
	}
	feed(decoder.decode());

	const text = rc.trim();
	if (text === "")
		throw new StepFailedError(
			name,
			-1,
			tail.lines(),
			`unit finished but ${rcPath} is missing or empty`,
		);
	// A signal death leaves a name such as TERM instead of a number.
	if (!/^\d+$/.test(text))
		throw new StepFailedError(
			name,
			-1,
			tail.lines(),
			`unit ended without an exit status (EXIT_STATUS=${text})`,
		);
	const exitStatus = Number(text);
	if (exitStatus !== 0)
		throw new StepFailedError(name, exitStatus, tail.lines());
	return { exitStatus, tail: tail.lines() };
}

/**
 * After an ambiguous start error: did the unit start (running, loaded, or already finished and
 * collected, which leaves its rc or log behind)? The unit may need a moment to show up, so a
 * "not found" answer is re-checked over `windowMs` before it counts.
 */
async function unitStarted(
	io: GuestIo,
	step: string,
	c: {
		unit: string;
		files: string[];
		deadline: number;
		windowMs: number;
		intervalMs: number;
	},
): Promise<boolean> {
	const until = Math.min(c.deadline, Date.now() + c.windowMs);
	let lastError: unknown;
	for (;;) {
		try {
			const r = await io.exec([
				"systemctl",
				"show",
				"-p",
				"LoadState,ActiveState",
				c.unit,
			]);
			const p = parseShow(r.stdout);
			if (
				p.LoadState === "loaded" ||
				/^(activ|deactiv)/.test(p.ActiveState ?? "")
			)
				return true;
			for (const f of c.files)
				if ((await io.readFile(f, 0, 1)).length > 0) return true;
			lastError = undefined;
		} catch (err) {
			if (!isTransientPoll(err)) throw err;
			lastError = err;
		}
		if (Date.now() >= until) break;
		await sleep(c.intervalMs);
	}
	// The last check did not answer: "not started" would be a guess.
	if (lastError !== undefined)
		throw new Error(
			`step ${step}: cannot tell whether the unit started: ${errorText(lastError)}`,
			{ cause: lastError },
		);
	return false;
}

/** Mounts the seed ISO read-only at /mnt/seed (idempotent). */
export async function mountSeed(io: GuestIo): Promise<void> {
	const r = await io.exec([
		"bash",
		"-c",
		`mkdir -p ${SEED_DIR} && (mountpoint -q ${SEED_DIR} || mount -o ro LABEL=cidata ${SEED_DIR})`,
	]);
	if (r.exitCode !== 0)
		throw new Error(
			`mounting the seed ISO failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
		);
}

async function readBootId(io: GuestIo): Promise<string> {
	const r = await io.exec(["cat", BOOT_ID_FILE]);
	if (r.exitCode !== 0)
		throw new Error(`reading ${BOOT_ID_FILE} failed: ${r.stderr.trim()}`);
	return r.stdout.trim();
}

/** Reboots the guest, waits for the agent under a new boot id and remounts the seed ISO. */
export async function rebootGuest(
	io: GuestIo,
	o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	const timeoutMs = o.timeoutMs ?? DEFAULT_REBOOT_TIMEOUT_MS;
	const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	const before = await readBootId(io);
	let reboot: ExecResult | undefined;
	try {
		reboot = await io.exec(["systemctl", "reboot"]);
	} catch {
		// The agent may die before it answers.
	}
	if (reboot && reboot.exitCode !== 0)
		throw new Error(`systemctl reboot failed: ${reboot.stderr.trim()}`);
	let last = "the guest agent never answered";
	for (;;) {
		await sleep(pollMs);
		if (Date.now() >= deadline)
			throw new Error(
				`guest did not reboot (new boot id and agent) within ${timeoutMs} ms; last state: ${last}`,
			);
		try {
			// The old system answers for a while after the reboot call.
			if (!(await io.ping())) {
				last = "ping failed";
				continue;
			}
			const now = await readBootId(io);
			if (now && now !== before) break;
			last = "boot id unchanged";
		} catch (err) {
			// The agent is going down or coming up.
			last = errorText(err);
		}
	}
	await mountSeed(io);
}
