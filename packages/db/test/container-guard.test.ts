// Cleanup of test containers whose test run died (container-guard.ts): the
// sweep removes containers of dead owners only, the watchdog removes its
// container once the owner process is gone.
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
	containerName,
	currentOwner,
	type Owner,
	ownerLabels,
	ownerOf,
	removeOrphans,
	startWatchdog,
	stopProcess,
} from "../src/testing/container-guard.ts";
import { TEST_PG_IMAGE } from "../src/testing/global-setup.ts";

const run = promisify(execFile);

function dockerAvailable(): boolean {
	try {
		execFileSync("docker", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function must<T>(v: T | null): T {
	if (v === null) throw new Error("no owner identity (ps)");
	return v;
}

/** Polls `fn` until it holds; a hang guard only. */
async function until(fn: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 60_000;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** A short-lived process: its owner identity, valid while it runs. */
async function ownerProcess() {
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	const pid = child.pid as number;
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	const owner = must(await ownerOf(pid));
	return {
		owner,
		kill: async () => {
			child.kill("SIGKILL");
			await exited;
			await until(async () => (await ownerOf(pid)) === null, "owner gone");
		},
	};
}

/** Runs `fn` with these environment variables, restoring them after. */
async function withEnv<T>(
	vars: Record<string, string>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved = Object.fromEntries(
		Object.keys(vars).map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const started: string[] = [];

/** A labelled container that only sleeps (the image is the test Postgres one). */
async function container(owner: Owner, name?: string): Promise<string> {
	const { stdout } = await run("docker", [
		"run",
		"-d",
		"--rm",
		...(name === undefined ? [] : ["--name", name]),
		...ownerLabels(owner),
		"--entrypoint",
		"sleep",
		TEST_PG_IMAGE,
		"300",
	]);
	const id = stdout.trim();
	started.push(id);
	return id;
}

async function exists(id: string): Promise<boolean> {
	const { stdout } = await run("docker", [
		"ps",
		"-a",
		"-q",
		"--no-trunc",
		"--filter",
		`id=${id}`,
	]);
	return stdout.trim() !== "";
}

const gone = (id: string) =>
	until(async () => !(await exists(id)), "the container removed");

describe("stopProcess (Watchdog.stop)", () => {
	it("sends SIGTERM only to the process with the recorded start time", async () => {
		const p = await ownerProcess();
		try {
			// Another start time: the pid was reused by another process.
			expect(stopProcess(p.owner.pid, "Thu Jan  1 00:00:00 1970")).toBe(false);
			expect(await ownerOf(p.owner.pid)).toEqual(p.owner);
			// Unknown start time: nothing is sent.
			expect(stopProcess(p.owner.pid, null)).toBe(false);
			expect(await ownerOf(p.owner.pid)).toEqual(p.owner);
			expect(stopProcess(p.owner.pid, p.owner.started)).toBe(true);
			await until(
				async () => (await ownerOf(p.owner.pid)) === null,
				"the process stopped",
			);
		} finally {
			await p.kill();
		}
	});
});

describe.skipIf(!dockerAvailable())("test container guard", () => {
	afterAll(async () => {
		for (const id of started) {
			await run("docker", ["rm", "-f", "-v", id]).catch(() => {});
		}
	});

	it("the sweep removes a container whose owner is gone and keeps one of a live owner", async () => {
		const dead = await ownerProcess();
		const orphan = await container(dead.owner);
		const live = await ownerProcess();
		const kept = await container(live.owner);
		const mine = await container(must(await currentOwner()));
		// The same pid with another start time is another process: its owner is gone.
		const reused = await container({
			...live.owner,
			started: "Thu Jan  1 00:00:00 1970",
		});
		await dead.kill();

		// Another package's sweep may remove the orphans first: check the state.
		await removeOrphans();
		expect(await exists(orphan)).toBe(false);
		expect(await exists(reused)).toBe(false);
		expect(await exists(kept)).toBe(true);
		expect(await exists(mine)).toBe(true);
		await live.kill();
	});

	it("labels written in one time zone and locale are read the same in another", async () => {
		const live = await ownerProcess();
		try {
			const owner = await withEnv(
				{ TZ: "Pacific/Chatham", LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" },
				async () => must(await ownerOf(live.owner.pid)),
			);
			const id = await container(owner);
			await withEnv(
				{
					TZ: "America/Los_Angeles",
					LC_ALL: "fr_FR.UTF-8",
					LANG: "fr_FR.UTF-8",
				},
				() => removeOrphans(),
			);
			expect(await exists(id)).toBe(true);
		} finally {
			await live.kill();
		}
	});

	it("the watchdog removes the container once its owner process dies", async () => {
		const owner = await ownerProcess();
		const id = await container(owner.owner);
		const dog = await startWatchdog(id, owner.owner);
		try {
			expect(await exists(id)).toBe(true);
			await owner.kill();
			await gone(id);
		} finally {
			dog.stop();
		}
	});

	it("the watchdog treats a reused pid (another start time) as a gone owner", async () => {
		const live = await ownerProcess();
		try {
			const id = await container(live.owner);
			const dog = await startWatchdog(id, {
				pid: live.owner.pid,
				started: "Thu Jan  1 00:00:00 1970",
			});
			try {
				await gone(id);
			} finally {
				dog.stop();
			}
		} finally {
			await live.kill();
		}
	});

	it("a watchdog started before the container removes one created after its owner died", async () => {
		const owner = await ownerProcess();
		const name = containerName();
		const dog = await startWatchdog(name, owner.owner);
		try {
			// The owner is gone (kill() waits until ps no longer lists it), then
			// the daemon finishes a create the dead owner had asked for.
			await owner.kill();
			const id = await container(owner.owner, name);
			await gone(id);
		} finally {
			dog.stop();
		}
	});
});
