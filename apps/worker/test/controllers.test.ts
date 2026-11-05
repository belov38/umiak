import { describe, expect, it } from "vitest";
import type { WorkerCtx } from "../src/context.ts";
import { activeControllers, CONTROLLERS } from "../src/controllers/index.ts";

describe("owner deployment controllers", () => {
	it("runs only the homelab lifecycle controllers", () => {
		expect(CONTROLLERS.map((c) => [c.queue, c.intervalMs])).toEqual([
			["ctl-start-queue", 1000],
			["ctl-health", 10000],
			["ctl-autostop", 15000],
			["ctl-cleanup", 600000],
			["ctl-reconcile", 60000],
		]);
		expect(activeControllers({} as WorkerCtx)).toEqual(CONTROLLERS);
	});
});
