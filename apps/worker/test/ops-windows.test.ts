// S9 Windows in the worker (S9 §12.10, §18.6 p. 5, 6, 10): shutdown timeout by
// OS, PrepareStop result, and the composite quiesce hook (agent + QGA/VSS).
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { FreezeTimeoutError, type QuiesceHook } from "@sbx/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSandboxOp } from "../src/handlers/sandbox-op.ts";
import { composeHooks, QuiesceFailed } from "../src/ops/snapshot-step.ts";
import { AgentUnavailable } from "../src/ports.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import {
	disconnectAgent,
	forkSandbox,
	type OpsEnv,
	opsEnv,
	readySandbox,
	row,
	run,
	snapshotLvs,
} from "./helpers/ops.ts";

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
	it("shutdown timeout is 120 s for windows and 60 s for linux", async () => {
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
			120,
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

describe("snapshot of a running Windows machine", () => {
	it("fork: agent quiesce (fs=false, wipe=false), QGA freeze, snapshot, QGA thaw, agent thaw", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const f = await forkSandbox(e, src.sandboxId);
		const trace = shareTrace(w);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect(trace).toEqual([
			"agent.quiesce(fs=false, wipe=false)",
			"qga.freeze",
			"snapshot",
			"qga.thaw",
			"agent.thaw",
		]);
	});

	it("saved: the agent is asked to wipe secret files", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		const trace = shareTrace(w);

		expect(await run(w, s.operationId)).toBe("succeeded");

		expect(trace).toEqual([
			"agent.quiesce(fs=false, wipe=true)",
			"qga.freeze",
			"snapshot",
			"qga.thaw",
			"agent.thaw",
		]);
		expect(await row(w, "snapshots", s.snapshotId)).toMatchObject({
			state: "ready",
			consistency: "quiesced",
		});
	});

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

	it("QGA freeze failure: the agent is thawed and the operation fails", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		const trace = shareTrace(w);
		w.infra.qgaFreezeFailure = new QuiesceFailed("VSS freeze failed");

		expect(await run(w, s.operationId)).toBe("failed");

		expect(trace).toEqual([
			"agent.quiesce(fs=false, wipe=true)",
			"qga.freeze(failed)",
			"agent.thaw",
		]);
		expect((await row(w, "operations", s.operationId)).error_code).toBe(
			"quiesce_failed",
		);
		expect(snapshotLvs(w, s.lvId)).toEqual([]);
	});

	it("VSS already released the writers at thaw: quiesce_failed, LVs removed", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		const trace = shareTrace(w);
		w.infra.qgaAlreadyThawed = true;

		expect(await run(w, s.operationId)).toBe("failed");

		// Both thaws are attempted even though the first fails.
		expect(trace.slice(-2)).toEqual(["qga.thaw", "agent.thaw"]);
		expect((await row(w, "operations", s.operationId)).error_code).toBe(
			"quiesce_failed",
		);
		expect(snapshotLvs(w, s.lvId)).toEqual([]);
	});

	it("saved with the agent unavailable: agent_unavailable, no QGA-only snapshot", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		await disconnectAgent(w, src.machineId);

		await expect(
			handleSandboxOp(w.ctx, { operationId: s.operationId }),
		).rejects.toBeInstanceOf(AgentUnavailable);

		expect(w.infra.callsOf("snapshot")).toHaveLength(0);
		expect(w.infra.callsOf("qgaFreezeHook")).toHaveLength(0);
		const op = await row(w, "operations", s.operationId);
		expect(op.state).toBe("running");
		expect(op.progress).not.toMatchObject({ quiesceVia: "qga" });
	});

	it("fork with the agent unavailable: QGA hook only", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const f = await forkSandbox(e, src.sandboxId);
		await disconnectAgent(w, src.machineId);
		const trace = shareTrace(w);

		expect(await run(w, f.forkOpId)).toBe("succeeded");

		expect(trace).toEqual(["qga.freeze", "snapshot", "qga.thaw"]);
		expect(w.agent.callsOf("freeze")).toHaveLength(0);
	});

	it("saved: an agent freeze that fails unavailable is retried through the agent, not QGA", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		w.agent.fail("freeze", "unavailable");

		await expect(
			handleSandboxOp(w.ctx, { operationId: s.operationId }),
		).rejects.toBeInstanceOf(AgentUnavailable);
		expect(
			(await row(w, "operations", s.operationId)).progress,
		).not.toMatchObject({ quiesceVia: "qga" });

		const trace = shareTrace(w);
		expect(await run(w, s.operationId)).toBe("succeeded");
		expect(trace[0]).toBe("agent.quiesce(fs=false, wipe=true)");
	});

	it("saved: S1 gives up after the agent froze (VSS slow): quiesce_failed, not blamed on the agent", async () => {
		const w = await createWorld(db);
		const e = opsEnv(w);
		const src = await readySandbox(w, e);
		await makeWindows(w);
		const s = await save(e, src.sandboxId, "win");
		w.infra.snapshotFailureAfterFreeze = new QuiesceFailed("freeze timed out", {
			cause: new FreezeTimeoutError("freeze did not return within 30000 ms"),
		});

		expect(await run(w, s.operationId)).toBe("failed");

		expect(w.agent.callsOf("freeze")).toHaveLength(1);
		expect((await row(w, "operations", s.operationId)).error_code).toBe(
			"quiesce_failed",
		);
		expect(snapshotLvs(w, s.lvId)).toEqual([]);
	});
});

describe("composeHooks", () => {
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
