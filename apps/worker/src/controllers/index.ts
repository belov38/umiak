import type { QueueName } from "@sbx/core";
import type { WorkerCtx } from "../context.ts";
import { runAutostop } from "./autostop.ts";
import { runCleanup } from "./cleanup.ts";
import { runHealth } from "./health.ts";
import { IDP_SYNC_INTERVAL_MS, runIdpSync } from "./idp-sync.ts";

// Periodic controllers (S6 §15.1). Each is an `exclusive` pg-boss queue whose
// job runs `run(ctx)` and then sends itself again with `startAfter =
// intervalMs`; a pg-boss cron once a minute per queue is the safety net
// (Task 13 wires both). `ctl-pool` is phase 2 (decision 17); `ctl-reconcile`
// is added by Task 12.

export interface ControllerSpec {
	queue: QueueName;
	intervalMs: number;
	run(ctx: WorkerCtx): Promise<unknown>;
	/** Registered only when this holds (default: always). */
	enabled?(ctx: WorkerCtx): boolean;
}

export const CONTROLLERS: readonly ControllerSpec[] = [
	{ queue: "ctl-health", intervalMs: 10_000, run: runHealth },
	{ queue: "ctl-autostop", intervalMs: 15_000, run: runAutostop },
	{ queue: "ctl-cleanup", intervalMs: 600_000, run: runCleanup },
	{
		queue: "ctl-idp-sync",
		intervalMs: IDP_SYNC_INTERVAL_MS,
		enabled: (ctx) => ctx.idpSync !== undefined,
		run: async (ctx) => {
			if (ctx.idpSync === undefined) return;
			await runIdpSync(ctx, ctx.idpSync);
		},
	},
];

/** The controllers to register for this context. */
export function activeControllers(ctx: WorkerCtx): ControllerSpec[] {
	return CONTROLLERS.filter((c) => c.enabled?.(ctx) ?? true);
}

export * from "./autostop.ts";
export * from "./cleanup.ts";
export * from "./health.ts";
export * from "./idp-sync.ts";
