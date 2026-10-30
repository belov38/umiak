// Operation (core) -> Operation resource (S7 §8.4): public ids, ISO times,
// `error {code, message, retryable}`; never `request` (it holds bodyHash).
import { encodeUuid } from "@sbx/auth";
import type { Operation } from "@sbx/core";
import type {
	OperationResource,
	PUBLIC_OPERATION_KINDS,
} from "../schemas/operation.ts";

export const iso = (d: Date): string => d.toISOString();
export const isoOrNull = (d: Date | null): string | null =>
	d === null ? null : d.toISOString();

/** Throws for `reprovision`: callers hide it first (`isPublicOperation`). */
export function toOperationResource(op: Operation): OperationResource {
	if (op.kind === "reprovision") {
		throw new Error("toOperationResource: reprovision is not public");
	}
	return {
		id: encodeUuid("operation", op.id),
		sandboxId: encodeUuid("sandbox", op.sandboxId),
		kind: op.kind as (typeof PUBLIC_OPERATION_KINDS)[number],
		state: op.state,
		step: op.step,
		error:
			op.errorCode === null
				? null
				: {
						code: op.errorCode,
						message: op.errorMessage ?? op.errorCode,
						retryable: op.retryable ?? false,
					},
		createdAt: iso(op.createdAt),
		startedAt: isoOrNull(op.startedAt),
		finishedAt: isoOrNull(op.finishedAt),
	};
}
