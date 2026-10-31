import { ThawFailedError } from "./storage/lvmthin.ts";

/** A Proxmox task or call that could not take the VM config lock. */
export const VM_LOCK_TIMEOUT_RE = /can't lock file .* got timeout/;

/**
 * How long after a start that follows a stop or shutdown the VM lock may still be held: qmeventd
 * waits up to 30 s for the old QEMU process before it gives up (seen on pve), plus a margin.
 * A snapshot in that window waits for the lock inside its freeze budget.
 */
export const VM_LOCK_AFTER_RESTART_MS = 35_000;

export interface VmLockRetryOptions {
	/** Snapshot pause/resume may consume its freeze budget while waiting for the same lock. */
	retryFreezeBudget?: boolean;
	/** Attempts in total (default 5). */
	tries?: number;
	/** Pause between attempts (default 10 s). */
	delayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	/** Called before each retry. */
	onRetry?: (err: unknown, attempt: number) => void;
}

/**
 * Runs fn again while it fails on the VM lock. After a shutdown or stop and a quick start,
 * qmeventd's cleanup of the old QEMU process holds the lock for up to 30 s (seen on pve), so a
 * stop or a snapshot right after a restart fails. A task that timed out on the lock did nothing.
 */
export async function retryOnVmLock<T>(
	fn: () => Promise<T>,
	o: VmLockRetryOptions = {},
): Promise<T> {
	const tries = o.tries ?? 5;
	const sleep =
		o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			// Failed thaw is an emergency-stop path; starting another snapshot
			// could leave a frozen guest behind, even if that stop hit a lock.
			if (
				err instanceof ThawFailedError ||
				(err instanceof Error && err.cause instanceof ThawFailedError)
			)
				throw err;
			const text = err instanceof Error ? err.message : String(err);
			const lock = VM_LOCK_TIMEOUT_RE.test(text);
			const budget =
				o.retryFreezeBudget &&
				/freeze took \d+(?:\.\d+)? ms \(budget \d+(?:\.\d+)? ms\)/.test(text);
			if (attempt >= tries || (!lock && !budget)) throw err;
			o.onRetry?.(err, attempt);
			await sleep(o.delayMs ?? 10_000);
		}
	}
}
