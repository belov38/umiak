import { PveApiError, type PveClient, Qga } from "@sbx/pve";
import {
	DEFAULT_POLL_MS,
	DEFAULT_REBOOT_TIMEOUT_MS,
	DEFAULT_STEP_TIMEOUT_MS,
	errorText,
	type GuestIo,
	isTransient,
	isTransientPoll,
	LogFollower,
	retryTransient,
	StepFailedError,
	StepTimeoutError,
	sleep,
	transientNotes,
} from "../runner.ts";

// Windows build steps through the QEMU guest agent (spec S9 section 7 p.5): a SYSTEM scheduled
// task runs run-step.ps1, the builder follows its log and exit file by byte offset.

const BUILD_VOLUME_LABEL = "SBXBUILD";
const LOG_DIR = "C:\\sbx-build\\logs";
/** The step name is also a file name and a task name; same pattern as run-step.ps1. */
const STEP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DRIVE_LETTER_RE = /^[A-Za-z]$/;
const START_CHECK_MS = 10_000;
/** Polls in a row that see no running task and no exit file before the step counts as dead. */
const DEAD_TASK_POLLS = 3;
const DEFAULT_NETWORK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SUBNET = "10.88.0.0/24";

const POWERSHELL = [
	"powershell.exe",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
] as const;

/**
 * QGA file-read errors that mean "not there (yet) or briefly locked". qemu-ga on Windows words an
 * open failure as `failed to open file '<path>' (mode: 'r'): The system cannot find the file
 * specified.`; a writer that holds the file without sharing gives "being used by another process".
 */
const NOT_READABLE_YET_RE =
	/failed to open file|cannot find the (file|path)|no such file|ENOENT|being used by another process|\(error: [23]\)/i;

const driveLetters = new WeakMap<GuestIo, string>();

const taskName = (step: string) => `sbx-build-${step}`;

function checkStepName(step: string): void {
	if (!STEP_NAME_RE.test(step)) throw new Error(`invalid step name "${step}"`);
}

/** Drive letter of the build ISO (volume label SBXBUILD), resolved once per guest. */
async function buildDrive(
	io: GuestIo,
	deadline: number,
	pollMs: number,
	note: (err: unknown) => void,
): Promise<string> {
	const known = driveLetters.get(io);
	if (known) return known;
	const r = await retryTransient(
		() =>
			io.exec([
				...POWERSHELL,
				`(Get-Volume -FileSystemLabel ${BUILD_VOLUME_LABEL}).DriveLetter`,
			]),
		deadline,
		pollMs,
		note,
	);
	const letter = r.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
	if (r.exitCode !== 0 || !DRIVE_LETTER_RE.test(letter))
		throw new Error(
			`no drive letter for the volume ${BUILD_VOLUME_LABEL} (exit ${r.exitCode}): ${
				(r.stderr || r.stdout).trim() || "empty answer"
			}`,
		);
	const upper = letter.toUpperCase();
	driveLetters.set(io, upper);
	return upper;
}

/** `Running` / `Ready` / ... of a task, or undefined when the query fails (no such task). */
async function taskStatus(
	io: GuestIo,
	task: string,
): Promise<string | undefined> {
	const r = await io.exec([
		"schtasks.exe",
		"/query",
		"/tn",
		task,
		"/fo",
		"csv",
		"/nh",
	]);
	if (r.exitCode !== 0) return undefined;
	const first = r.stdout.trim().split(/\r?\n/)[0] ?? "";
	// "\sbx-build-x","N/A","Running"
	return [...first.matchAll(/"([^"]*)"/g)][2]?.[1];
}

/** Stops and removes a task; a missing task is fine, and so is a guest that does not answer. */
async function dropTask(io: GuestIo, task: string): Promise<void> {
	for (const verb of ["/end", "/delete"]) {
		try {
			await io.exec(
				verb === "/end"
					? ["schtasks.exe", verb, "/tn", task]
					: ["schtasks.exe", verb, "/f", "/tn", task],
			);
		} catch {
			// Cleanup only.
		}
	}
}

/**
 * Reads one guest file; a file that cannot be opened reads as empty. The writer of the log and
 * the exit file is run-step.ps1, so "not there yet" and "locked for a moment" are normal.
 */
async function readSoft(
	io: GuestIo,
	path: string,
	offset: number,
	count: number,
): Promise<Buffer> {
	try {
		return await io.readFile(path, offset, count);
	} catch (err) {
		if (err instanceof PveApiError && NOT_READABLE_YET_RE.test(err.message))
			return Buffer.alloc(0);
		throw err;
	}
}

export interface WindowsStepOptions {
	/** Step name; `[A-Za-z0-9][A-Za-z0-9._-]*`. */
	step: string;
	/** Default 60 min. */
	timeoutMs?: number;
	/** Default 2 s. */
	pollMs?: number;
	/** Receives decoded log text as it grows. */
	onLog(chunk: string): void;
	signal?: AbortSignal;
	/** How long to re-check the task after an ambiguous start error (default 10 s). */
	startCheckMs?: number;
}

/**
 * Runs one build step as a SYSTEM scheduled task and follows `<step>.log` and `<step>.exit` of
 * run-step.ps1 by byte offset, so a long step never depends on a QGA exec timeout. The task is
 * removed afterwards, also when the step fails or times out.
 */
export async function runWindowsStep(
	io: GuestIo,
	o: WindowsStepOptions,
): Promise<void> {
	const { step } = o;
	checkStepName(step);
	const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
	const timeoutMs = o.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const task = taskName(step);
	const logPath = `${LOG_DIR}\\${step}.log`;
	const exitPath = `${LOG_DIR}\\${step}.exit`;
	const note = transientNotes(o.onLog);
	const follower = new LogFollower(
		(offset, count) => readSoft(io, logPath, offset, count),
		o.onLog,
	);

	const drive = await buildDrive(io, deadline, pollMs, note);
	const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${drive}:\\build\\run-step.ps1 -Step ${step}`;

	try {
		await dropTask(io, task);
		// A stale exit file of an earlier attempt must not be taken for this run. The step name is
		// validated above, so it is safe in script text.
		const prep = await retryTransient(
			() =>
				io.exec([
					...POWERSHELL,
					`New-Item -ItemType Directory -Force -Path ${LOG_DIR} | Out-Null; ` +
						`Remove-Item -Force -ErrorAction SilentlyContinue ${exitPath}, ${exitPath}.tmp, ${logPath}; ` +
						// -Command exits 1 when the last statement had an error, even a silenced one.
						"exit 0",
				]),
			deadline,
			pollMs,
			note,
		);
		if (prep.exitCode !== 0)
			throw new Error(
				`step ${step}: preparing ${LOG_DIR} failed: ${prep.stderr.trim()}`,
			);

		// /f makes create idempotent. A past /st only gives a warning on stderr; the task is only
		// ever started with /run.
		const create = await retryTransient(
			() =>
				io.exec([
					"schtasks.exe",
					"/create",
					"/f",
					"/tn",
					task,
					"/ru",
					"SYSTEM",
					"/sc",
					"once",
					"/st",
					"00:00",
					"/rl",
					"HIGHEST",
					"/tr",
					command,
				]),
			deadline,
			pollMs,
			note,
		);
		if (create.exitCode !== 0)
			throw new Error(
				`step ${step}: schtasks /create failed (exit ${create.exitCode}): ${create.stderr.trim()}`,
			);

		try {
			const run = await io.exec(["schtasks.exe", "/run", "/tn", task]);
			if (run.exitCode !== 0)
				throw new Error(
					`step ${step}: schtasks /run failed (exit ${run.exitCode}): ${run.stderr.trim()}`,
				);
		} catch (err) {
			if (!isTransient(err)) throw err;
			// The task may have started; it is never started twice blindly.
			if (
				!(await taskStarted(io, step, {
					task,
					files: [exitPath, logPath],
					deadline,
					windowMs: o.startCheckMs ?? START_CHECK_MS,
					intervalMs: pollMs,
				}))
			)
				throw new Error(`step ${step}: task did not start: ${errorText(err)}`, {
					cause: err,
				});
		}

		let deadPolls = 0;
		let lastError: unknown;
		for (;;) {
			if (o.signal?.aborted)
				throw o.signal.reason instanceof Error
					? o.signal.reason
					: new Error(`step ${step} aborted`);
			let code: string | undefined;
			try {
				// Task state before the exit file: a task seen as finished has written it already.
				const status = await taskStatus(io, task);
				const exit = (await readSoft(io, exitPath, 0, 64))
					.toString("utf8")
					.trim();
				// The exit file is written last, so a finished step has its whole log drained.
				await follower.drain(exit !== "");
				if (exit !== "") code = exit;
				else if (!/^(running|queued)$/i.test(status ?? "")) deadPolls++;
				else deadPolls = 0;
			} catch (err) {
				if (!isTransientPoll(err)) throw err;
				note(err);
				lastError = err;
			}
			if (code !== undefined) {
				follower.flush();
				finish(step, code, follower.lines());
				return;
			}
			if (deadPolls >= DEAD_TASK_POLLS) {
				follower.flush();
				throw new StepFailedError(
					step,
					-1,
					follower.lines(),
					`task ended without writing ${exitPath}`,
				);
			}
			if (Date.now() >= deadline) {
				follower.flush();
				throw new StepTimeoutError(
					step,
					timeoutMs,
					follower.lines(),
					lastError,
				);
			}
			await sleep(pollMs);
		}
	} finally {
		await dropTask(io, task);
	}
}

function finish(step: string, code: string, tail: string[]): void {
	if (!/^\d+$/.test(code))
		throw new StepFailedError(
			step,
			-1,
			tail,
			`unexpected exit file content "${code.slice(0, 40)}"`,
		);
	const status = Number(code);
	if (status !== 0) throw new StepFailedError(step, status, tail);
}

/**
 * After an ambiguous start error: did the task start (running, or it already wrote its log or
 * exit file)? The task may need a moment to show up, so a negative answer is re-checked over
 * `windowMs` before it counts.
 */
async function taskStarted(
	io: GuestIo,
	step: string,
	c: {
		task: string;
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
			if (/^(running|queued)$/i.test((await taskStatus(io, c.task)) ?? ""))
				return true;
			for (const f of c.files)
				if ((await readSoft(io, f, 0, 1)).length > 0) return true;
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
			`step ${step}: cannot tell whether the task started: ${errorText(lastError)}`,
			{ cause: lastError },
		);
	return false;
}

async function bootTime(io: GuestIo): Promise<string> {
	const r = await io.exec([
		...POWERSHELL,
		"(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')",
	]);
	const text = r.stdout.trim();
	if (r.exitCode !== 0 || text === "")
		throw new Error(
			`reading LastBootUpTime failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
		);
	return text;
}

/**
 * Reboots the guest and waits for the agent under a new boot time. The old system keeps
 * answering for a while, and a quick reboot can fall between two polls, so a new boot time
 * decides, not the loss of the ping.
 */
export async function rebootWindows(
	io: GuestIo,
	o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	const timeoutMs = o.timeoutMs ?? DEFAULT_REBOOT_TIMEOUT_MS;
	const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	const before = await bootTime(io);
	let reboot: Awaited<ReturnType<GuestIo["exec"]>> | undefined;
	try {
		reboot = await io.exec(["shutdown.exe", "/r", "/t", "0"]);
	} catch {
		// The agent may die before it answers.
	}
	if (reboot && reboot.exitCode !== 0)
		throw new Error(`shutdown /r failed: ${reboot.stderr.trim()}`);
	let last = "the guest agent never answered";
	for (;;) {
		await sleep(pollMs);
		if (Date.now() >= deadline)
			throw new Error(
				`guest did not reboot (new boot time and agent) within ${timeoutMs} ms; last state: ${last}`,
			);
		try {
			if (!(await io.ping())) {
				last = "ping failed";
				continue;
			}
			const now = await bootTime(io);
			if (now !== before) return;
			last = "boot time unchanged";
		} catch (err) {
			// The agent is going down or coming up.
			last = errorText(err);
		}
	}
}

const hexOnly = (mac: string) => mac.replace(/[^0-9a-f]/gi, "").toLowerCase();

function ipv4ToInt(ip: string): number | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return undefined;
	const parts = m.slice(1).map(Number);
	if (parts.some((p) => p > 255)) return undefined;
	return (
		(((parts[0] ?? 0) << 24) |
			((parts[1] ?? 0) << 16) |
			((parts[2] ?? 0) << 8) |
			(parts[3] ?? 0)) >>>
		0
	);
}

function inSubnet(ip: string, cidr: string): boolean {
	const [base, bitsText] = cidr.split("/");
	const bits = Number(bitsText);
	const a = ipv4ToInt(ip);
	const b = ipv4ToInt(base ?? "");
	if (a === undefined || b === undefined || !(bits >= 0 && bits <= 32))
		return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (a & mask) === (b & mask);
}

/** Sets `link_down=0` on net0 (the rest of the string stays) and waits for an IPv4 of the VM. */
export async function networkUp(
	api: PveClient,
	node: string,
	vmid: number,
	mac: string,
	o: { subnet?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
	const subnet = o.subnet ?? DEFAULT_SUBNET;
	const timeoutMs = o.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
	const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
	const base = `/nodes/${node}/qemu/${vmid}`;

	const config = await api.get<Record<string, string>>(`${base}/config`);
	const net0 = config.net0;
	if (!net0) throw new Error(`VM ${vmid} has no net0`);
	const fields = net0.split(",");
	const own = /^[a-z0-9_]+=([0-9a-f:]{17})$/i.exec(fields[0] ?? "")?.[1];
	if (!own || hexOnly(own) !== hexOnly(mac))
		throw new Error(`net0 of VM ${vmid} is "${net0}", expected MAC ${mac}`);
	const up = [
		...fields.filter((f) => !f.startsWith("link_down=")),
		"link_down=0",
	];
	const done = await api.put<unknown>(`${base}/config`, { net0: up.join(",") });
	if (typeof done === "string" && done.startsWith("UPID:"))
		await api.waitTask(node, done);

	const qga = new Qga(api, node);
	const deadline = Date.now() + timeoutMs;
	let last = "no network interface with the VM MAC yet";
	for (;;) {
		try {
			const nic = (await qga.interfaces(vmid)).find(
				(i) =>
					i["hardware-address"] !== undefined &&
					hexOnly(i["hardware-address"]) === hexOnly(mac),
			);
			const ip = nic?.["ip-addresses"]?.find(
				(a) =>
					a["ip-address-type"] === "ipv4" && inSubnet(a["ip-address"], subnet),
			);
			if (ip) return;
			last = nic
				? `no IPv4 in ${subnet} on ${nic.name}`
				: "no network interface with the VM MAC yet";
		} catch (err) {
			// The agent or the link is still coming up.
			if (!isTransientPoll(err)) throw err;
			last = errorText(err);
		}
		if (Date.now() >= deadline)
			throw new Error(
				`VM ${vmid} got no IPv4 in ${subnet} within ${timeoutMs} ms: ${last}`,
			);
		await sleep(pollMs);
	}
}
