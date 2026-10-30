import { type PveClient, Qga } from "@sbx/pve";
import {
	DEFAULT_POLL_MS,
	DEFAULT_REBOOT_TIMEOUT_MS,
	DEFAULT_STEP_TIMEOUT_MS,
	errorText,
	type GuestIo,
	isTransient,
	isTransientPoll,
	LogFollower,
	READ_CHUNK,
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

/** powershell.exe with the script as -EncodedCommand: no quoting through QGA and the command line. */
function encodedPowershell(script: string): string[] {
	return [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}

const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`;

/**
 * Registers (or replaces: -Force) the SYSTEM task of a step in one exec. Not schtasks /create:
 * its tasks run at priority 7, below normal CPU and low I/O, which slows installers and DISM
 * down. No trigger: the task is only ever started with schtasks /run.
 */
function registerTaskScript(task: string, args: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"$action = New-ScheduledTaskAction -Execute 'powershell.exe' " +
			`-Argument ${psQuote(args)}`,
		"$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
		"$settings = New-ScheduledTaskSettingsSet -Priority 4 -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
		`Register-ScheduledTask -TaskName ${psQuote(task)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
	].join("\n");
}

/**
 * Body of the read script; the caller puts $exitPath, $logPath, $offset and $count in front.
 * Both files are opened with FileShare ReadWrite|Delete, so a writer is never locked out, and
 * the handle is closed by the time the exec answers. QGA file-read must not be used for files a
 * guest process writes: when a guest-file-open times out, qemu-ga on Windows keeps the handle,
 * opened without FILE_SHARE_WRITE, and every later write of the file fails. The exit file is
 * read before the log. A file that cannot be opened (missing, locked) reads as absent.
 * Windows PowerShell 5.1: keep it ASCII and 5.1-compatible.
 */
const READ_FILES_BODY = `$ErrorActionPreference = 'Stop'
$share = [System.IO.FileShare]'ReadWrite, Delete'
$exit = $null
if ($exitPath -ne '') {
    try {
        $f = [System.IO.File]::Open($exitPath, 'Open', 'Read', $share)
        try { $exit = (New-Object System.IO.StreamReader($f)).ReadToEnd() } finally { $f.Dispose() }
    } catch [System.IO.IOException] { $exit = $null }
}
$size = 0
$data = ''
try {
    $f = [System.IO.File]::Open($logPath, 'Open', 'Read', $share)
    try {
        $size = $f.Length
        if ($offset -lt $size) {
            $buf = New-Object byte[] ([int][Math]::Min([long]$count, $size - $offset))
            [void]$f.Seek($offset, 'Begin')
            $n = 0
            while ($n -lt $buf.Length) {
                $r = $f.Read($buf, $n, $buf.Length - $n)
                if ($r -le 0) { break }
                $n += $r
            }
            $data = [Convert]::ToBase64String($buf, 0, $n)
        }
    } finally { $f.Dispose() }
} catch [System.IO.IOException] { $size = 0; $data = '' }
[Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ exit = $exit; size = $size; data = $data })))
`;

export interface GuestFiles {
	/** Content of the exit file; null when it was not asked for or cannot be opened. */
	exit: string | null;
	/** Length of the log when it was read; 0 when it cannot be opened. */
	size: number;
	/** Up to `count` bytes of the log from `offset`. */
	data: Buffer;
}

/**
 * Reads an optional exit file and a chunk of a log with one PowerShell exec. Missing or locked
 * files are not an error; a failing script is.
 */
export async function readGuestFiles(
	io: GuestIo,
	r: { exit?: string; log: string; offset: number; count: number },
): Promise<GuestFiles> {
	if (!Number.isSafeInteger(r.offset) || r.offset < 0)
		throw new Error(`bad offset ${r.offset}`);
	if (!Number.isSafeInteger(r.count) || r.count <= 0)
		throw new Error(`bad count ${r.count}`);
	const script = [
		`$exitPath = ${psQuote(r.exit ?? "")}`,
		`$logPath = ${psQuote(r.log)}`,
		`$offset = ${r.offset}`,
		`$count = ${r.count}`,
		READ_FILES_BODY,
	].join("\n");
	const res = await io.exec(encodedPowershell(script));
	const line = res.stdout.trim().split(/\r?\n/).at(-1) ?? "";
	if (res.exitCode !== 0)
		throw new Error(
			`reading ${r.log} failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim()}`,
		);
	let j: { exit?: unknown; size?: unknown; data?: unknown };
	try {
		j = JSON.parse(line);
	} catch {
		throw new Error(
			`reading ${r.log}: unexpected answer "${line.slice(0, 200)}"`,
		);
	}
	if (
		!(j.exit === null || typeof j.exit === "string") ||
		typeof j.size !== "number" ||
		typeof j.data !== "string"
	)
		throw new Error(
			`reading ${r.log}: unexpected answer "${line.slice(0, 200)}"`,
		);
	return { exit: j.exit, size: j.size, data: Buffer.from(j.data, "base64") };
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
		async (offset, count) =>
			(await readGuestFiles(io, { log: logPath, offset, count })).data,
		o.onLog,
	);

	const drive = await buildDrive(io, deadline, pollMs, note);
	const register = registerTaskScript(
		task,
		`-NoProfile -ExecutionPolicy Bypass -File ${drive}:\\build\\run-step.ps1 -Step ${step}`,
	);
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

		const create = await retryTransient(
			() => io.exec(encodedPowershell(register)),
			deadline,
			pollMs,
			note,
		);
		if (create.exitCode !== 0)
			throw new Error(
				`step ${step}: registering the task failed (exit ${create.exitCode}): ${(create.stderr || create.stdout).trim()}`,
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
					exitPath,
					logPath,
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
				const files = await readGuestFiles(io, {
					exit: exitPath,
					log: logPath,
					offset: follower.offset,
					count: READ_CHUNK,
				});
				follower.accept(files.data);
				const exit = files.exit?.trim() ?? "";
				// The exit file is written last and read before the log, so once it is there the log
				// is complete and is drained to its end.
				if (follower.offset < files.size) await follower.drain(exit !== "");
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
		exitPath: string;
		logPath: string;
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
			const files = await readGuestFiles(io, {
				exit: c.exitPath,
				log: c.logPath,
				offset: 0,
				count: 1,
			});
			if (files.exit !== null || files.size > 0) return true;
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
	// qemu-ga for Windows loses exec statuses now and then (seen right after a step); retry.
	const before = await retryTransient(
		() => bootTime(io),
		deadline,
		pollMs,
		() => {},
	);
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
