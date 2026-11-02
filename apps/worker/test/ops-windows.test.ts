// S9 Windows in the worker (S9 §12.10, §18.6 p. 5, 6, 10): shutdown timeout by
// OS, PrepareStop result, and snapshot hooks (Windows: only from a stopped VM,
// S9 §24.8; the forced flow is in ops-force-stop.test.ts).
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import type { QuiesceHook } from "@umiak/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeHooks } from "../src/ops/snapshot-step.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import { type OpsEnv, opsEnv, readySandbox, row, run } from "./helpers/ops.ts";

let db: TestDatabase;

beforeAll(async () => {
	db = await createTestDatabase();
});

afterAll(async () => {
	await db?.drop();
});

async function makeWindows(w: TestWorld): Promise<void> {
	await w.pool.query(
		"UPDATE runtime.template_builds SET os = 'windows' WHERE id = $1",
		[w.topo.templateBuildId],
	);
}

async function save(e: OpsEnv, sandboxId: string, name: string) {
	const r = await e.svc.saveSnapshot(e.p, sandboxId, name);
	return {
		snapshotId: r.snapshot.id,
		operationId: r.operation.id,
		lvId: r.snapshot.id.replaceAll("-", ""),
	};
}

function shareTrace(w: TestWorld): string[] {
	const trace: string[] = [];
	w.agent.trace = trace;
	w.infra.trace = trace;
	return trace;
}

describe("stop on Windows", () => {
	it("shutdown timeout is 300 s for windows and 60 s for linux", async () => {
		const lin = await createWorld(db);
		const le = opsEnv(lin);
		const ls = await readySandbox(lin, le);
		const lop = await le.svc.stop(le.p, ls.sandboxId);
		expect(await run(lin, lop.id)).toBe("succeeded");
		expect(lin.infra.callsOf("shutdown")[0]?.args).toEqual([
			expect.any(Number),
			60,
		]);

		const win = await createWorld(db);
		const we = opsEnv(win);
		const ws = await readySandbox(win, we);
		await makeWindows(win);
		const wop = await we.svc.stop(we.p, ws.sandboxId);
		expect(await run(win, wop.id)).toBe("succeeded");
		expect(win.infra.callsOf("shutdown")[0]?.args).toEqual([
			expect.any(Number),
			300,
		]);
	});

	it("ctx.timing.shutdownTimeoutS overrides the OS default", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		await makeWindows(w);
		w.ctx.timing.shutdownTimeoutS = 7;
		const op = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");
		expect(w.infra.callsOf("shutdown")[0]?.args[1]).toBe(7);
	});

	it("records secretFilesWiped from PrepareStop in the operation progress", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		w.agent.secretFilesWiped = true;
		const op = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");
		expect((await row(w, "operations", op.id)).progress).toMatchObject({
			prepared: true,
			secretFilesWiped: true,
		});
	});

	it("an unavailable agent records secretFilesWiped = false", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const s = await readySandbox(w, e);
		w.agent.fail("prepareStop", "unavailable");
		const op = await e.svc.stop(e.p, s.sandboxId);
		expect(await run(w, op.id)).toBe("succeeded");
		expect((await row(w, "operations", op.id)).progress).toMatchObject({
			prepared: false,
			secretFilesWiped: false,
		});
	});
});

describe("snapshot hooks", () => {
	it("Linux keeps the plain agent hook: fs and wipe are not sent, no QGA hook", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		const s = await save(e, src.sandboxId, "lin");
		const trace = shareTrace(w);

		expect(await run(w, s.operationId)).toBe("succeeded");

		expect(trace).toEqual([
			"agent.quiesce(fs=true, wipe=false)",
			"snapshot",
			"agent.thaw",
		]);
		expect(w.agent.callsOf("freeze")[0]?.args).toEqual({ leaseMs: 30_000 });
		expect(w.infra.callsOf("qgaFreezeHook")).toHaveLength(0);
	});

	it("Windows forced save: no agent quiesce, no QGA/VSS, powered_off", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		w.agent.secretFilesWiped = true;
		const r = await e.svc.saveSnapshot(e.p, src.sandboxId, "win", undefined, {
			forceStop: true,
		});
		const trace = shareTrace(w);

		expect(await run(w, r.operation.id)).toBe("succeeded");

		expect(trace).toEqual(["snapshot"]);
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
		expect(w.infra.callsOf("qgaFreezeHook")).toHaveLength(0);
		expect(await row(w, "snapshots", r.snapshot.id)).toMatchObject({
			state: "ready",
			consistency: "powered_off",
		});
	});
});

describe("composeHooks", () => {
	it("does not start VSS after an aborted slow agent freeze", async () => {
		const log: string[] = [];
		let release!: () => void;
		const h = composeHooks(
			{
				freeze: () =>
					new Promise<void>((r) => {
						release = r;
					}),
				thaw: async () => {
					log.push("outer.thaw");
				},
			},
			recorder("inner", log),
		);
		const pending = h.freeze();
		await h.thaw();
		release();
		await pending;
		expect(log).not.toContain("inner.freeze");
	});

	function recorder(name: string, log: string[], fail?: "freeze" | "thaw") {
		const hook: QuiesceHook = {
			freeze: async () => {
				log.push(`${name}.freeze`);
				if (fail === "freeze") throw new Error(`${name} freeze failed`);
			},
			thaw: async () => {
				log.push(`${name}.thaw`);
				if (fail === "thaw") throw new Error(`${name} thaw failed`);
			},
		};
		return hook;
	}

	it("freezes outer then inner, thaws inner then outer", async () => {
		const log: string[] = [];
		const h = composeHooks(recorder("o", log), recorder("i", log));
		await h.freeze();
		await h.thaw();
		expect(log).toEqual(["o.freeze", "i.freeze", "i.thaw", "o.thaw"]);
	});

	it("inner freeze failure thaws outer and rethrows the freeze error", async () => {
		const log: string[] = [];
		const h = composeHooks(recorder("o", log), recorder("i", log, "freeze"));
		await expect(h.freeze()).rejects.toThrow("i freeze failed");
		expect(log).toEqual(["o.freeze", "i.freeze", "o.thaw"]);
	});

	it("outer freeze failure does not freeze inner", async () => {
		const log: string[] = [];
		const h = composeHooks(recorder("o", log, "freeze"), recorder("i", log));
		await expect(h.freeze()).rejects.toThrow("o freeze failed");
		expect(log).toEqual(["o.freeze"]);
	});

	it("thaw attempts both and rethrows the first error", async () => {
		const log: string[] = [];
		const h = composeHooks(
			recorder("o", log, "thaw"),
			recorder("i", log, "thaw"),
		);
		await expect(h.thaw()).rejects.toThrow("i thaw failed");
		expect(log).toEqual(["i.thaw", "o.thaw"]);
	});
});
