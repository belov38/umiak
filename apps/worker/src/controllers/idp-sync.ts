import type { WorkerCtx } from "../context.ts";

// Controller `idp-sync` (decision 15, S8 §17.2, §20.1): an `exclusive` queue
// that runs a pluggable sync every `UMIAK_IDP_SYNC_INTERVAL` (300 s). The logic
// lives in `@umiak/payload` (`KeycloakIdpSync`); without an implementation the
// controller is not registered.

/** What a pass reports; `KeycloakIdpSync.run()` returns a superset. */
export interface IdpSyncOutcome {
	/** The pass changed nothing because a guard tripped. */
	aborted: boolean;
	abort?: { reason: string; wouldDeactivate?: number; active?: number };
	deactivated?: readonly string[];
	reactivated?: readonly string[];
}

export interface IdpSync {
	// biome-ignore lint/suspicious/noConfusingVoidType: a sync without a result returns Promise<void>
	run(): Promise<IdpSyncOutcome | void>;
}

/** Default interval of `ctl-idp-sync` (`UMIAK_IDP_SYNC_INTERVAL`, 300 s). */
export const IDP_SYNC_INTERVAL_MS = 300_000;

/**
 * Runs the sync once; errors are logged, counted and rethrown (pg-boss
 * retries). An aborted pass counts `umiak_idp_sync_aborted_total{reason}`,
 * sets the gauge `umiak_idp_sync_aborted` to 1 and logs an error; a completed
 * pass sets the gauge to 0. A failed pass leaves the gauge as it was.
 */
export async function runIdpSync(ctx: WorkerCtx, sync: IdpSync): Promise<void> {
	const started = Date.now();
	let out: IdpSyncOutcome | undefined;
	try {
		out = (await sync.run()) ?? undefined;
	} catch (err) {
		ctx.metrics.inc("umiak_idp_sync_total", { result: "failed" });
		ctx.log.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"idp sync failed",
		);
		throw err;
	}
	const ms = Date.now() - started;
	ctx.metrics.observe("umiak_idp_sync_duration_seconds", ms / 1000);
	if (out?.aborted) {
		const reason = out.abort?.reason ?? "unknown";
		ctx.metrics.inc("umiak_idp_sync_total", { result: "aborted" });
		ctx.metrics.inc("umiak_idp_sync_aborted_total", { reason });
		ctx.metrics.set("umiak_idp_sync_aborted", 1);
		ctx.log.error(
			{ durationMs: ms, ...out.abort, reason },
			"idp sync aborted: nothing changed",
		);
		return;
	}
	ctx.metrics.inc("umiak_idp_sync_total", { result: "ok" });
	ctx.metrics.set("umiak_idp_sync_aborted", 0);
	ctx.log.info(
		{
			durationMs: ms,
			deactivated: out?.deactivated?.length ?? 0,
			reactivated: out?.reactivated?.length ?? 0,
		},
		"idp sync done",
	);
}
