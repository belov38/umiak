// Cleanup of test Postgres containers whose test run died without its
// teardown: a SIGKILL, a crash, or `pnpm -r test` stopping the other
// packages after a failure.
//
// Every container started by global-setup carries owner labels: the host,
// the pid of the process that started it and that process's start time
// (`ps -o lstart=`; with the pid it names one process even when the pid is
// reused later). Two guards use them:
//
// 1. A watchdog: a small detached node process (its own process group, so a
//    kill of the runner's group does not reach it) that checks the owner pid
//    every second and removes the container once the owner is gone. It is
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
import { type ChildProcess, execFile, spawn } from "node:child_process";
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
	/** `ps -o lstart=` of the pid. */
	started: string;
}

/** Start time of a process, or null when it does not exist. Throws when `ps` cannot tell. */
async function startedAt(pid: number): Promise<string | null> {
	try {
		const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
		const s = stdout.trim();
		return s === "" ? null : s;
	} catch (err) {
		// ps exits 1 (empty output) when there is no such process.
		const e = err as { code?: unknown; stdout?: string };
		if (e.code === 1 && (e.stdout ?? "").trim() === "") return null;
		throw err;
	}
}

/** This process as the owner of a container. */
export async function currentOwner(): Promise<Owner> {
	const started = await startedAt(process.pid);
	if (started === null) throw new Error("ps does not list this process");
	return { host: hostname(), pid: process.pid, started };
}

/** A unique name for a new test container of this process. */
export function containerName(): string {
	return `sbx-test-pg-${process.pid}-${randomUUID().slice(0, 8)}`;
}

/** `docker run` arguments that label a container with its owner. */
export function ownerLabels(o: Owner): string[] {
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

// The watchdog's program (node -e): argv owner pid, container name or id.
// Once the owner is gone it removes the container, repeating for up to a
// minute while there is no such container yet (a create still in flight).
const WATCHDOG = `
const { execFile } = require("node:child_process");
const pid = Number(process.argv[1]);
const ref = process.argv[2];
const alive = () => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
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

/**
 * Starts the watchdog of the container `ref` (name or id) owned by
 * `ownerPid` (this process by default). Stop it with `kill()` after the
 * container is removed.
 */
export function startWatchdog(
	ref: string,
	ownerPid = process.pid,
): ChildProcess {
	const child = spawn(
		process.execPath,
		["-e", WATCHDOG, String(ownerPid), ref],
		{ detached: true, stdio: "ignore" },
	);
	child.on("error", () => {});
	child.unref();
	return child;
}
