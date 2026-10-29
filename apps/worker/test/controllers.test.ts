import { describe, expect, it } from "vitest";
import {
	createLogger,
	RecordingMetrics,
	type WorkerCtx,
} from "../src/context.ts";
import {
	activeControllers,
	CONTROLLERS,
	type IdpSync,
	runIdpSync,
} from "../src/controllers/index.ts";

function ctx(idpSync?: IdpSync): WorkerCtx {
	const metrics = new RecordingMetrics();
	return {
		log: createLogger({ level: "silent" }),
		metrics,
		...(idpSync ? { idpSync } : {}),
	} as unknown as WorkerCtx;
}

describe("CONTROLLERS (§15.1)", () => {
	it("health 10 s, autostop 15 s, cleanup 10 min, idp-sync 300 s; no pool", () => {
		expect(CONTROLLERS.map((c) => [c.queue, c.intervalMs])).toEqual([
			["ctl-health", 10_000],
			["ctl-autostop", 15_000],
			["ctl-cleanup", 600_000],
			["ctl-idp-sync", 300_000],
		]);
	});

	it("ctl-idp-sync is registered only with an IdpSync", async () => {
		expect(activeControllers(ctx()).map((c) => c.queue)).toEqual([
			"ctl-health",
			"ctl-autostop",
			"ctl-cleanup",
		]);
		let runs = 0;
		const c = ctx({
			run: async () => {
				runs += 1;
			},
		});
		const idp = activeControllers(c).find((x) => x.queue === "ctl-idp-sync");
		expect(idp).toBeDefined();
		await idp?.run(c);
		expect(runs).toBe(1);
	});

	it("runIdpSync counts results and rethrows a failure", async () => {
		const ok = ctx();
		await runIdpSync(ok, { run: async () => {} });
		const m = ok.metrics as RecordingMetrics;
		expect(
			m.calls.find((x) => x.name === "sbx_idp_sync_total")?.labels,
		).toEqual({ result: "ok" });

		const bad = ctx();
		await expect(
			runIdpSync(bad, {
				run: async () => {
					throw new Error("idp down");
				},
			}),
		).rejects.toThrow("idp down");
		expect(
			(bad.metrics as RecordingMetrics).calls.find(
				(x) => x.name === "sbx_idp_sync_total",
			)?.labels,
		).toEqual({ result: "failed" });
	});
});
