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

export interface SbxErrorOptions {
	retryable?: boolean;
	details?: Record<string, unknown>;
	cause?: unknown;
}

export class SbxError extends Error {
	readonly code: ErrorCode;
	readonly retryable: boolean;
	readonly details: Record<string, unknown>;

	constructor(code: ErrorCode, message: string, opts: SbxErrorOptions = {}) {
		super(
			message,
			opts.cause === undefined ? undefined : { cause: opts.cause },
		);
		this.name = "SbxError";
		this.code = code;
		this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
		this.details = opts.details ?? {};
	}
}

export function isSbxError(e: unknown, code?: ErrorCode): e is SbxError {
	return e instanceof SbxError && (code === undefined || e.code === code);
}

export function notFound(what = "resource"): SbxError {
	return new SbxError("not_found", `${what} not found`);
}

export function invalidState(
	state: string | null,
	extra: Record<string, unknown> = {},
): SbxError {
	return new SbxError(
		"invalid_state",
		`operation is not allowed in state '${state ?? "none"}'`,
		{ details: { state, ...extra } },
	);
}

export function operationInProgress(op: {
	id: string;
	kind: string;
}): SbxError {
	return new SbxError(
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
): SbxError {
	return new SbxError(
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

export function poolExhausted(retryAfterSeconds: number): SbxError {
	return new SbxError(
		"pool_exhausted",
		`no warm machine available; retry in ${retryAfterSeconds} s`,
		{ details: { retryAfterSeconds } },
	);
}

export function quotaExceeded(
	quota: string,
	limit: number,
	current: number,
): SbxError {
	return new SbxError(
		"quota_exceeded",
		`quota '${quota}' exceeded (${current} of ${limit})`,
		{ details: { quota, limit, current } },
	);
}

export function validation(issues: ValidationIssue[]): SbxError {
	const first = issues[0];
	const message = first
		? `${first.path}: ${first.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`
		: "validation failed";
	return new SbxError("validation", message, { details: { issues } });
}

export function templateUnavailable(
	template: string,
	size: string | null = null,
): SbxError {
	return new SbxError(
		"template_unavailable",
		size === null
			? `template '${template}' is not available`
			: `size '${size}' is not available for template '${template}'`,
		{ details: { template, size } },
	);
}

export function snapshotNotFound(name: string): SbxError {
	return new SbxError(
		"snapshot_not_found",
		`saved snapshot '${name}' not found`,
		{
			details: { name },
		},
	);
}

export function idempotencyKeyReused(): SbxError {
	return new SbxError(
		"idempotency_key_reused",
		"the Idempotency-Key was already used with a different request",
	);
}

export function slugTaken(slug: string): SbxError {
	return new SbxError("slug_taken", `slug '${slug}' is already taken`, {
		details: { slug },
	});
}

export function sandboxNotReady(
	state: string,
	extra: Record<string, unknown> = {},
): SbxError {
	return new SbxError(
		"sandbox_not_ready",
		`sandbox is not ready (state '${state}')`,
		{ details: { state, ...extra } },
	);
}

export function recoverRateLimited(retryAfterSeconds: number): SbxError {
	return new SbxError(
		"recover_rate_limited",
		`recover was called recently; retry in ${retryAfterSeconds} s`,
		{ details: { retryAfterSeconds } },
	);
}
