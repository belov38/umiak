// Operation (core) -> Operation resource (S7 §8.4): public ids, ISO times,
// `error {code, message, retryable}`; never `request` (it holds bodyHash).
import { encodeUuid } from "@umiak/auth";
import type { Operation } from "@umiak/core";
import type {
	OperationResource,
	PUBLIC_OPERATION_KINDS,
} from "../schemas/operation.ts";

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null =>
	d === null ? null : d.toISOString();

/**
 * S9 §24.8: a forced fork/save_snapshot (`request.forceStop`) reports the
 * stop and restart of the source from its progress (worker force-stop.ts).
 */
function forceStopOf(op: Operation): OperationResource["forceStop"] {
	if (op.request.forceStop !== true) return null;
	const p = op.progress;
	const err = p.restartError as { code?: unknown; message?: unknown } | null;
	return {
		sourceStopped: p.forceStopped === true,
		sourceRestarted:
			typeof p.sourceRestarted === "boolean" ? p.sourceRestarted : null,
		restartError:
			err && typeof err.code === "string"
				? {
						code: err.code,
						message: typeof err.message === "string" ? err.message : err.code,
					}
				: null,
	};
}

/** Throws for `reprovision`: callers hide it first (`isPublicOperation`). */
export function toOperationResource(op: Operation): OperationResource {
	if (op.kind === "reprovision") {
		throw new Error("toOperationResource: reprovision is not public");
	}
	return {
		id: encodeUuid("operation", op.id),
		sandboxId: encodeUuid("sandbox", op.sandboxId),
		kind: op.kind as (typeof PUBLIC_OPERATION_KINDS)[number],
		state:
			op.progress.phase === "queued" &&
			["pending", "running"].includes(op.state)
				? "queued"
				: op.state,
		...(op.progress.phase === "queued"
			? {
					progress: {
						phase: op.progress.phase as "queued",
						...(typeof op.progress.targetNode === "string"
							? { targetNode: op.progress.targetNode }
							: {}),
						...(typeof op.progress.verifiedBytes === "number"
							? { verifiedBytes: op.progress.verifiedBytes }
							: {}),
						...(typeof op.progress.totalBytes === "number"
							? { totalBytes: op.progress.totalBytes }
							: {}),
						...(typeof op.progress.queuedUntil === "string"
							? { queuedUntil: op.progress.queuedUntil }
							: {}),
					},
				}
			: {}),
		step: op.step,
		error:
			op.errorCode === null
				? null
				: {
						code: op.errorCode,
						message: op.errorMessage ?? op.errorCode,
						retryable: op.retryable ?? false,
					},
		forceStop: forceStopOf(op),
		createdAt: iso(op.createdAt),
		startedAt: isoOrNull(op.startedAt),
		finishedAt: isoOrNull(op.finishedAt),
	};
}
