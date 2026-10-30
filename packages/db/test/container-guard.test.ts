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
	removeOrphans,
	startWatchdog,
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

/** A short-lived process: its owner identity, valid while it runs. */
async function ownerProcess() {
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	const pid = child.pid as number;
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	const me = await currentOwner();
	const { stdout } = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
	const owner: Owner = { host: me.host, pid, started: stdout.trim() };
	return {
		owner,
		kill: async () => {
			child.kill("SIGKILL");
			await exited;
		},
	};
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
		const mine = await container(await currentOwner());
		// The same pid with another start time is another process: its owner is gone.
		const reused = await container({
			...live.owner,
			started: "Thu Jan  1 00:00:00 1970",
		});
		await dead.kill();

		const removed = await removeOrphans();
		expect(removed).toContain(orphan.slice(0, 12));
		expect(await exists(orphan)).toBe(false);
		expect(await exists(reused)).toBe(false);
		expect(await exists(kept)).toBe(true);
		expect(await exists(mine)).toBe(true);
		await live.kill();
	});

	it("the watchdog removes the container once its owner process dies", async () => {
		const owner = await ownerProcess();
		const id = await container(owner.owner);
		const dog = await startWatchdog(id, owner.owner.pid);
		try {
			expect(await exists(id)).toBe(true);
			await owner.kill();
			await gone(id);
		} finally {
			dog.stop();
		}
	});

	/** Polls until the container is gone (the watchdog checks every second). */
	async function gone(id: string): Promise<void> {
		const end = Date.now() + 60_000;
		while (await exists(id)) {
			if (Date.now() > end) throw new Error("the watchdog did not remove it");
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	it("a watchdog started before the container removes one created after its owner died", async () => {
		const owner = await ownerProcess();
		const name = containerName();
		const dog = await startWatchdog(name, owner.owner.pid);
		try {
			await owner.kill();
			// The daemon finishes a create the dead owner had asked for.
			await new Promise((r) => setTimeout(r, 1500));
			const id = await container(owner.owner, name);
			await gone(id);
		} finally {
			dog.stop();
		}
	});
});
