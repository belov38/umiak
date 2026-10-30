// Cleanup of test Postgres containers whose test run died without its
// teardown: a SIGKILL, a crash, or `pnpm -r test` stopping the other
// packages after a failure.
//
// Every container started by global-setup (and by the Postgres setup of
// @sbx/agent-client's tests) carries owner labels: the host,
// the pid of the process that started it and that process's start time
// (`ps -o lstart=` with TZ=UTC and the C locale, so every session reads the
// same text; with the pid it names one process even when the pid is reused
// later). Without a usable `ps` the container gets no owner labels and only
// the watchdog guards it. Two guards use them:
//
// 1. A watchdog: a small node process started through a launcher that exits
//    at once (double fork): its parent is init and it has its own session, so
//    neither a kill of the runner's process group nor a kill of the runner's
//    process tree reaches it. It checks the owner pid every second (and its
//    start time every 10 s, against pid reuse) and removes the container
//    once the owner is gone. It is
//    started before `docker run` and knows the container by its unique name,
//    so a kill while `docker run` is still running is covered too; it repeats
//    the removal for a while in case the daemon finishes the create after
//    the owner died. The owner's teardown removes the container itself and
//    stops the watchdog.
// 2. A sweep at the next setup: containers of this host whose owner process
//    no longer exists are removed. It covers a watchdog that died too (a
//    reboot, a kill of every process of the user).
//
// A container is removed only when its owner is known to be gone; one of a
// live owner (another session's run, a watch mode), of another host, or
// without owner labels (started by an older global-setup) is left alone.
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Marks every test Postgres container of global-setup. */
export const TEST_PG_LABEL = "sbx-test=pg";
const HOST = "sbx-test.host";
const PID = "sbx-test.pid";
const STARTED = "sbx-test.started";

export interface Owner {
	host: string;
	pid: number;
	/** `ps -o lstart=` of the pid in UTC and the C locale. */
	started: string;
}

/** `ps` prints the start time in the time zone and locale of its environment. */
const psEnv = () => ({ ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" });

/** Start time of a process, or null when it does not exist. Throws when `ps` cannot tell. */
async function startedAt(pid: number): Promise<string | null> {
	try {
		const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)], {
			env: psEnv(),
		});
		const s = stdout.trim();
		return s === "" ? null : s;
	} catch (err) {
		// ps exits 1 (empty output) when there is no such process.
		const e = err as { code?: unknown; stdout?: string };
		if (e.code === 1 && (e.stdout ?? "").trim() === "") return null;
		throw err;
	}
}

/** startedAt without awaiting: null when there is no such process or `ps` cannot tell. */
function startedAtSync(pid: number): string | null {
	try {
		const s = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			env: psEnv(),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return s === "" ? null : s;
	} catch {
		return null;
	}
}

/**
 * Sends SIGTERM to `pid` only while it is the process that started at
 * `started` (`ps -o lstart=`): a pid that was reused by another process, or
 * a start time that is unknown, gets nothing. True when the signal was sent.
 */
export function stopProcess(pid: number, started: string | null): boolean {
	if (started === null || startedAtSync(pid) !== started) return false;
	try {
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false; // Gone meanwhile.
	}
}

/**
 * The process `pid` as the owner of a container; null when it does not exist
 * or `ps` cannot tell its start time.
 */
export async function ownerOf(pid: number): Promise<Owner | null> {
	try {
		const started = await startedAt(pid);
		return started === null ? null : { host: hostname(), pid, started };
	} catch {
		return null;
	}
}

/**
 * This process as the owner of a container; null when `ps` cannot tell its
 * start time (the database setup then goes on without owner labels).
 */
export function currentOwner(): Promise<Owner | null> {
	return ownerOf(process.pid);
}

/** A unique name for a new test container of this process. */
export function containerName(): string {
	return `sbx-test-pg-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** `docker run` arguments that label a container with its owner. */
export function ownerLabels(o: Owner | null): string[] {
	if (o === null) return ["--label", TEST_PG_LABEL];
	return [
		"--label",
		TEST_PG_LABEL,
		"--label",
		`${HOST}=${o.host}`,
		"--label",
		`${PID}=${o.pid}`,
		"--label",
		`${STARTED}=${o.started}`,
	];
}

/** Whether the owner process is gone for sure (false when unknown). */
async function ownerGone(o: Owner): Promise<boolean> {
	try {
		const started = await startedAt(o.pid);
		return started === null || started !== o.started;
	} catch {
		return false;
	}
}

/**
 * Removes the test containers of this host whose owner process is gone.
 * Best effort: every failure is ignored. Returns the removed ids.
 */
export async function removeOrphans(): Promise<string[]> {
	let listed: string;
	try {
		const { stdout } = await run("docker", [
			"ps",
			"-a",
			"--filter",
			`label=${TEST_PG_LABEL}`,
			"--format",
			`{{.ID}}\t{{.Label "${HOST}"}}\t{{.Label "${PID}"}}\t{{.Label "${STARTED}"}}`,
		]);
		listed = stdout;
	} catch {
		return [];
	}
	const host = hostname();
	const removed: string[] = [];
	for (const line of listed.split("\n")) {
		const [id, h, pid, started] = line.split("\t");
		if (!id || h !== host || !pid || !started) continue;
		const o = { host: h, pid: Number(pid), started };
		if (!Number.isSafeInteger(o.pid) || !(await ownerGone(o))) continue;
		try {
			await run("docker", ["rm", "-f", "-v", id]);
			removed.push(id);
		} catch {
			// Removed meanwhile by its watchdog or another sweep.
		}
	}
	return removed;
}

// The watchdog's program (node -e): argv owner pid, container name or id,
// owner start time (empty when unknown). Once the owner is gone it removes
// the container, repeating for up to a minute while there is no such
// container yet (a create still in flight).
const WATCHDOG = `
const { execFile, execFileSync } = require("node:child_process");
const pid = Number(process.argv[1]);
const ref = process.argv[2];
const started = process.argv[3] || "";
const env = { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" };
let checkedAt = 0;
const sameProcess = () => {
	if (started === "" || Date.now() - checkedAt < 10000) return true;
	checkedAt = Date.now();
	try {
		const s = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return s.trim() === started;
	} catch (e) {
		// ps exits 1 without such a process; anything else: cannot tell.
		return e.status !== 1;
	}
};
const alive = () => {
	try {
		process.kill(pid, 0);
	} catch (e) {
		if (e.code !== "EPERM") return false;
	}
	return sameProcess();
};
// docker rm -f exits 0 for a missing container too; only a removal prints
// the reference.
const remove = (end) =>
	execFile("docker", ["rm", "-f", "-v", ref], (err, stdout) => {
		if ((!err && String(stdout).trim() !== "") || Date.now() > end) {
			process.exit(0);
		}
		setTimeout(() => remove(end), 2000);
	});
const t = setInterval(() => {
	if (alive()) return;
	clearInterval(t);
	remove(Date.now() + 60000);
}, 1000);
`;

// The launcher (node -e): starts the watchdog (argv: its program, owner
// pid, ref, owner start time) detached, prints its pid and exits.
const LAUNCHER = `
const { spawn } = require("node:child_process");
const [program, pid, ref, started] = process.argv.slice(1);
const child = spawn(process.execPath, ["-e", program, pid, ref, started], {
	detached: true,
	stdio: "ignore",
});
child.unref();
process.stdout.write(String(child.pid));
`;

export interface Watchdog {
	/**
	 * Stops the watchdog (after the owner removed the container itself). The
	 * signal goes only to the watchdog process itself (its start time is
	 * checked, against a pid reused after the watchdog exited); a watchdog
	 * that cannot be identified is left to exit on its own once the owner
	 * is gone.
	 */
	stop(): void;
}

/**
 * Starts the watchdog of the container `ref` (name or id) owned by `owner`
 * (this process by default; `started` checks against pid reuse when known);
 * resolves once it runs.
 */
export function startWatchdog(
	ref: string,
	owner: { pid: number; started?: string } = { pid: process.pid },
): Promise<Watchdog> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["-e", LAUNCHER, WATCHDOG, String(owner.pid), ref, owner.started ?? ""],
			(err, stdout) => {
				const pid = Number(String(stdout).trim());
				if (err || !Number.isSafeInteger(pid) || pid <= 0) {
					reject(err ?? new Error(`watchdog launcher printed ${stdout}`));
					return;
				}
				startedAt(pid).then(
					(started) => resolve({ stop: () => stopProcess(pid, started) }),
					() => resolve({ stop: () => {} }),
				);
			},
		);
	});
}
