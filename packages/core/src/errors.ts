// Domain errors of the control plane. S7 maps `code` to HTTP (S7 §5.5).

export const ERROR_CODES = [
	// S6 §14.1
	"not_found",
	"invalid_state",
	"operation_in_progress",
	"out_of_capacity",
	"pool_exhausted",
	"quota_exceeded",
	"idempotency_key_reused",
	"template_unavailable",
	"snapshot_not_found",
	"sandbox_not_ready",
	"recover_rate_limited",
	"validation",
	// Executor additions (S7 §5.5 codes produced by core, and the DLQ outcome)
	"slug_taken",
	"snapshot_name_taken",
	"agent_unavailable",
	"retries_exhausted",
	// A running Windows sandbox is forked or saved only with forceStop (S9 §24.8).
	"snapshot_requires_stop",
	// S8 C3: operator rights and blocks; `details.reason` says which
	// (operator_required, sandbox_blocked, port_blocked).
	"forbidden",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Codes whose request may be repeated safely and may succeed later. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
	"operation_in_progress",
	"out_of_capacity",
	"pool_exhausted",
	"recover_rate_limited",
	"agent_unavailable",
]);

export interface ValidationIssue {
	path: string;
	message: string;
}

export interface UmiakErrorOptions {
	retryable?: boolean;
	details?: Record<string, unknown>;
	cause?: unknown;
}

export class UmiakError extends Error {
	readonly code: ErrorCode;
	readonly retryable: boolean;
	readonly details: Record<string, unknown>;

	constructor(code: ErrorCode, message: string, opts: UmiakErrorOptions = {}) {
		super(
			message,
			opts.cause === undefined ? undefined : { cause: opts.cause },
		);
		this.name = "UmiakError";
		this.code = code;
		this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
		this.details = opts.details ?? {};
	}
}

export function isUmiakError(e: unknown, code?: ErrorCode): e is UmiakError {
	return e instanceof UmiakError && (code === undefined || e.code === code);
}

export function notFound(what = "resource"): UmiakError {
	return new UmiakError("not_found", `${what} not found`);
}

export function invalidState(
	state: string | null,
	extra: Record<string, unknown> = {},
): UmiakError {
	return new UmiakError(
		"invalid_state",
		`operation is not allowed in state '${state ?? "none"}'`,
		{ details: { state, ...extra } },
	);
}

export function operationInProgress(op: {
	id: string;
	kind: string;
}): UmiakError {
	return new UmiakError(
		"operation_in_progress",
		`a '${op.kind}' operation is already in progress; retry after it finishes`,
		{ details: { operationId: op.id, kind: op.kind } },
	);
}

/** `reason`: why a fixed node refused, e.g. `node_not_active` (placement.ts). */
export function outOfCapacity(
	retryAfterSeconds: number,
	cause?: unknown,
	reason?: string,
): UmiakError {
	return new UmiakError(
		"out_of_capacity",
		reason === undefined
			? `not enough capacity; retry in ${retryAfterSeconds} s`
			: `not enough capacity (${reason}); retry in ${retryAfterSeconds} s`,
		{
			details: {
				retryAfterSeconds,
				...(reason === undefined ? {} : { reason }),
			},
			...(cause === undefined ? {} : { cause }),
		},
	);
}

export function quotaExceeded(
	quota: string,
	limit: number,
	current: number,
	requested?: number,
	note?: string,
): UmiakError {
	const unit = quota === "maxRamMb" ? " MB" : "";
	const usage =
		requested === undefined
			? `${current} of ${limit}`
			: `${current}${unit} in use + ${requested}${unit} requested > limit ${limit}${unit}`;
	return new UmiakError(
		"quota_exceeded",
		`quota '${quota}' exceeded (${usage})${note ? `; ${note}` : ""}`,
		{
			details: {
				quota,
				limit,
				current,
				...(requested === undefined ? {} : { requested }),
			},
		},
	);
}

export function validation(issues: ValidationIssue[]): UmiakError {
	const first = issues[0];
	const message = first
		? `${first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`
		: "validation failed";
	return new UmiakError("validation", message, { details: { issues } });
}

export function templateUnavailable(
	template: string,
	size: string | null = null,
): UmiakError {
	return new UmiakError(
		"template_unavailable",
		size === null
			? `template '${template}' is not available`
			: `size '${size}' is not available for template '${template}'`,
		{ details: { template, size } },
	);
}

export function snapshotNotFound(name: string): UmiakError {
	return new UmiakError(
		"snapshot_not_found",
		`saved snapshot '${name}' not found`,
		{
			details: { name },
		},
	);
}

/**
 * Fork or saved snapshot of a running Windows sandbox without `forceStop`
 * (S9 §24.8): Windows disks are snapshotted only from a stopped VM. The
 * message and details tell the client how to retry.
 */
export function windowsSnapshotRequiresStop(
	kind: "fork" | "save_snapshot",
): UmiakError {
	const what =
		kind === "fork"
			? "Windows sandboxes are forked from a stopped VM"
			: "Windows snapshots are saved from a stopped VM";
	return new UmiakError(
		"snapshot_requires_stop",
		`${what}; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again`,
		{
			details: {
				reason: "windows_running",
				retryWith: { forceStop: true },
				cli: "--force-stop",
			},
		},
	);
}

export function idempotencyKeyReused(): UmiakError {
	return new UmiakError(
		"idempotency_key_reused",
		"the Idempotency-Key was already used with a different request",
	);
}

export function slugTaken(slug: string): UmiakError {
	return new UmiakError("slug_taken", `slug '${slug}' is already taken`, {
		details: { slug },
	});
}

export function sandboxNotReady(
	state: string,
	extra: Record<string, unknown> = {},
): UmiakError {
	return new UmiakError(
		"sandbox_not_ready",
		`sandbox is not ready (state '${state}')`,
		{ details: { state, ...extra } },
	);
}

export function recoverRateLimited(retryAfterSeconds: number): UmiakError {
	return new UmiakError(
		"recover_rate_limited",
		`recover was called recently; retry in ${retryAfterSeconds} s`,
		{ details: { retryAfterSeconds } },
	);
}

/** An operator-only action by anyone else (S8 C3). */
export function operatorRequired(): UmiakError {
	return new UmiakError(
		"forbidden",
		"only a platform operator (browser session) may do this",
		{ details: { reason: "operator_required" } },
	);
}

/** A change of a sandbox an operator has blocked (S8 C3). */
export function sandboxBlocked(): UmiakError {
	return new UmiakError(
		"forbidden",
		"the sandbox is blocked by the platform operator; only reads, stop and delete are allowed",
		{ details: { reason: "sandbox_blocked" } },
	);
}

/** A change of a hosted port an operator has blocked (S8 C3). */
export function portBlocked(port: number): UmiakError {
	return new UmiakError(
		"forbidden",
		`port ${port} is blocked by the platform operator`,
		{ details: { reason: "port_blocked", port } },
	);
}
