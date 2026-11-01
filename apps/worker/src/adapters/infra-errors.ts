// Error policy of the real NodeInfra adapter: which S1 errors are permanent
// for the step engine, and secret scrubbing of every message that leaves the
// adapter (the SMBIOS serial carries the machine's bootstrap secret).
import {
	AllocatorError,
	FreezeBudgetExceededError,
	FreezeTimeoutError,
	NodeOpsError,
	PveApiError,
	PveTaskError,
	QgaExecStatusLostError,
	QgaTimeoutError,
	QgaUnavailableError,
	SnapshotModeRequiredError,
	StorageFullError,
	ThawFailedError,
	TracesRemainError,
} from "@sbx/pve";
import { QuiesceFailed } from "../ops/snapshot-step.ts";
import { isRetryable } from "../ports.ts";

/** NodeInfra methods, for error classification and logs. */
export type InfraOp =
	| "create"
	| "fork"
	| "start"
	| "shutdown"
	| "stop"
	| "status"
	| "configure"
	| "vmSize"
	| "delete"
	| "leaseOf"
	| "snapshot"
	| "deleteSnapshot"
	| "listVms"
	| "listLvs"
	| "removeLvs"
	| "qgaPing"
	| "qgaExec";

/**
 * An S1 failure as the worker sees it: a scrubbed message, a code and the
 * `retryable` flag the step engine reads. The original error is not attached:
 * its message, `errors` or cause may echo the SMBIOS serial.
 */
export class InfraError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly op: InfraOp | undefined;
	/** HTTP status of a PVE API error. */
	readonly status: number | undefined;
	constructor(
		code: string,
		message: string,
		o: { retryable: boolean; op?: InfraOp; status?: number },
	) {
		super(message);
		this.name = "InfraError";
		this.code = code;
		this.retryable = o.retryable;
		this.op = o.op;
		this.status = o.status;
	}
}

const REDACTED = "<redacted>";

// base64("sbx1:") starts every encoded serial; the raw payload starts with "sbx1:".
const SECRET_PATTERNS: [RegExp, string][] = [
	// "smbios1": "..." inside a JSON errors object.
	[/("smbios1"\s*:\s*")(?:[^"\\]|\\.)*"/g, `$1${REDACTED}"`],
	// smbios1=<value> up to whitespace or a quote (the value contains commas).
	[/smbios1=[^\s"']*/g, `smbios1=${REDACTED}`],
	[/serial=[^\s,"'&]*/g, `serial=${REDACTED}`],
	[/c2J4MTo[A-Za-z0-9+/_-]*={0,2}/g, REDACTED],
	[/sbx1:[^\s,"']*/g, REDACTED],
];

/** Removes SMBIOS serial values (raw and base64) and smbios1 strings from a text. */
export function scrubSecrets(text: string): string {
	let out = text;
	for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
	return out;
}

function messageOf(err: unknown): string {
	return scrubSecrets(err instanceof Error ? err.message : String(err));
}

const TRANSIENT_4XX_RE = /can't lock|lock file|locked|timeout|timed out/i;

/**
 * A pool-scoped token gets this 403 for a VM that no longer exists (or was
 * just deleted): a retry re-checks existence instead of failing for good.
 */
const VM_PERMISSION_RE = /Permission check failed \(\/vms\/\d+/;

function pveApiRetryable(err: PveApiError): boolean {
	if (err.status < 400 || err.status >= 500) return true;
	if (err.status === 404 || err.status === 409) return true;
	if (err.status === 403 && VM_PERMISSION_RE.test(err.message)) return true;
	return TRANSIENT_4XX_RE.test(err.message);
}

/**
 * Maps an error thrown by S1 (or by a quiesce hook) to what the worker sees.
 *
 * Permanent (`retryable: false`): quiesce failures of a snapshot (QGA does not
 * answer, freeze budget exceeded, thaw failed) as `QuiesceFailed`, and PVE API
 * 4xx answers other than 404, 409, lock or timeout messages and the 403
 * "Permission check failed (/vms/<id>, ...)" of a VM that is gone, and S1's
 * refusal of a running Windows snapshot without a mode. Port errors
 * with their own `retryable` flag (AgentUnavailable, AgentRejected from the
 * hook) pass through. Everything else is transient, including
 * TracesRemainError (the verified delete is repeated).
 */
export function classifyInfraError(err: unknown, op?: InfraOp): Error {
	if (
		err instanceof Error &&
		typeof (err as { retryable?: unknown }).retryable === "boolean"
	) {
		const scrubbed = scrubSecrets(err.message);
		if (scrubbed !== err.message) err.message = scrubbed;
		return err;
	}
	const at = op !== undefined ? { op } : {};
	if (err instanceof ThawFailedError) {
		// The agent's hook failed to answer: its watchdog thaws the guest, and
		// the snapshot step falls back to QGA on the next attempt.
		if (isRetryable(err.cause)) return classifyInfraError(err.cause, op);
		return new QuiesceFailed(messageOf(err));
	}
	if (err instanceof FreezeBudgetExceededError)
		return new QuiesceFailed(messageOf(err));
	// The cause lets the snapshot step tell a slow agent hook from a slow QGA freeze.
	if (err instanceof FreezeTimeoutError)
		return new QuiesceFailed(messageOf(err), { cause: err });
	if (err instanceof QgaUnavailableError) {
		if (op === "snapshot") return new QuiesceFailed(messageOf(err));
		return new InfraError("qga_unavailable", messageOf(err), {
			retryable: true,
			...at,
		});
	}
	// S9 §24.8: never a silent crash-consistent Windows snapshot.
	if (err instanceof SnapshotModeRequiredError)
		return new InfraError("snapshot_requires_stop", messageOf(err), {
			retryable: false,
			...at,
		});
	if (err instanceof TracesRemainError)
		return new InfraError("traces_remain", messageOf(err), {
			retryable: true,
			...at,
		});
	if (err instanceof QgaTimeoutError)
		return new InfraError("qga_timeout", messageOf(err), {
			retryable: true,
			status: err.status,
			...at,
		});
	if (err instanceof PveApiError) {
		const retryable = pveApiRetryable(err);
		return new InfraError(
			retryable ? "pve_error" : "pve_rejected",
			messageOf(err),
			{ retryable, status: err.status, ...at },
		);
	}
	const transient = (code: string) =>
		new InfraError(code, messageOf(err), { retryable: true, ...at });
	if (err instanceof PveTaskError) return transient("pve_task_failed");
	if (err instanceof QgaExecStatusLostError)
		return transient("qga_exec_status_lost");
	if (err instanceof StorageFullError) return transient("storage_full");
	if (err instanceof AllocatorError) return transient(err.code);
	if (err instanceof NodeOpsError)
		// busy: sbx-node found a file it guards mid-rewrite (dnsmasq leases).
		return transient(err.code === "busy" ? "node_busy" : "node_ops_error");
	return transient("infra_error");
}

/** A permanent rejection decided by the adapter itself (guards). */
export function infraRejected(
	code: string,
	message: string,
	op: InfraOp,
): InfraError {
	return new InfraError(code, message, { retryable: false, op });
}
