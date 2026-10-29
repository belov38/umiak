import type { WorkerCtx } from "../context.ts";

// Controller `idp-sync` (decision 15, S8 §17.2): an `exclusive` queue that
// runs a pluggable sync every `SBX_IDP_SYNC_INTERVAL` (300 s). The logic lives
// in `@sbx/payload` (S8); without an implementation the controller is not
// registered.

export interface IdpSync {
	run(): Promise<void>;
}

/** Default interval of `ctl-idp-sync` (`SBX_IDP_SYNC_INTERVAL`, 300 s). */
export const IDP_SYNC_INTERVAL_MS = 300_000;

/** Runs the sync once; errors are logged, counted and rethrown (pg-boss retries). */
export async function runIdpSync(ctx: WorkerCtx, sync: IdpSync): Promise<void> {
	const started = Date.now();
	try {
		await sync.run();
	} catch (err) {
		ctx.metrics.inc("sbx_idp_sync_total", { result: "failed" });
		ctx.log.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"idp sync failed",
		);
		throw err;
	}
	const ms = Date.now() - started;
	ctx.metrics.inc("sbx_idp_sync_total", { result: "ok" });
	ctx.metrics.observe("sbx_idp_sync_duration_seconds", ms / 1000);
	ctx.log.info({ durationMs: ms }, "idp sync done");
}
