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
	constructor(step: string, timeoutMs: number, tail: string[]) {
		super(`step ${step} did not finish within ${timeoutMs} ms`);
		this.name = "StepTimeoutError";
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

/** Errors that only mean the guest agent did not answer in time; the call can be repeated. */
function isTransient(err: unknown): boolean {
	if (err instanceof QgaTimeoutError || err instanceof QgaExecStatusLostError)
		return true;
	if (err instanceof PveApiError)
		return /guest agent is not running|got timeout/i.test(err.message);
	// Qga.exec gives up with a plain Error.
	return err instanceof Error && /guest exec .* timed out/.test(err.message);
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
		this.#lines.push(...parts);
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

	const prep = await io.exec(["bash", "-c", PREPARE_SCRIPT, "sbx-prep", name]);
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
		if (!(await unitStarted(io, unit, logPath, rcPath, deadline)))
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
	const drain = async () => {
		for (;;) {
			const buf = await io.readFile(logPath, offset, READ_CHUNK);
			offset += buf.length;
			feed(decoder.decode(buf, { stream: true }));
			if (buf.length < READ_CHUNK) return;
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
		await drain();
		// A collected unit reads as inactive.
		if (state !== "inactive" && state !== "failed") return undefined;
		return (await io.readFile(rcPath, 0, 64)).toString("utf8");
	};

	let rc: string | undefined;
	for (;;) {
		try {
			rc = await poll();
		} catch (err) {
			if (!isTransient(err)) throw err;
		}
		if (rc !== undefined) break;
		if (Date.now() >= deadline) {
			feed(decoder.decode());
			throw new StepTimeoutError(name, timeoutMs, tail.lines());
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

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** After an ambiguous start error: did the unit start (running, loaded, or already finished)? */
async function unitStarted(
	io: GuestIo,
	unit: string,
	logPath: string,
	rcPath: string,
	deadline: number,
): Promise<boolean> {
	for (;;) {
		try {
			const r = await io.exec([
				"systemctl",
				"show",
				"-p",
				"LoadState,ActiveState",
				unit,
			]);
			const p = parseShow(r.stdout);
			if (
				p.LoadState === "loaded" ||
				/^(activ|deactiv)/.test(p.ActiveState ?? "")
			)
				return true;
			// Already finished and collected: it left its rc or log behind.
			for (const f of [rcPath, logPath])
				if ((await io.readFile(f, 0, 1)).length > 0) return true;
			return false;
		} catch (err) {
			if (!isTransient(err) || Date.now() >= deadline) throw err;
			await sleep(500);
		}
	}
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
	for (;;) {
		await sleep(pollMs);
		if (Date.now() >= deadline)
			throw new Error(
				`guest did not reboot (new boot id and agent) within ${timeoutMs} ms`,
			);
		try {
			// The old system answers for a while after the reboot call.
			if (!(await io.ping())) continue;
			const now = await readBootId(io);
			if (now && now !== before) break;
		} catch {
			// The agent is going down or coming up.
		}
	}
	await mountSeed(io);
}
