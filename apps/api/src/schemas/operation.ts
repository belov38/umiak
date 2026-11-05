// Operation resource (S7 §8.4). Internal `reprovision` operations and the
// stored request (`request`, its `bodyHash`) are never part of it.
import { z } from "@hono/zod-openapi";
import { OPERATION_STATES } from "@umiak/core";
import { extensibleEnum } from "../openapi/registry.ts";
import { NullableTimestamp, Timestamp } from "./common.ts";

export const PUBLIC_OPERATION_KINDS = [
	"create",
	"fork",
	"stop",
	"resume",
	"recover",
	"delete",
	"save_snapshot",
] as const;

export const OperationSchema = z
	.object({
		id: z.string().openapi({ example: "op_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		sandboxId: z.string().openapi({ example: "sb_01jbx4q3m7f8r2t6v9w0y1z2a3" }),
		kind: extensibleEnum(PUBLIC_OPERATION_KINDS),
		state: extensibleEnum([...OPERATION_STATES, "queued"] as const).openapi({
			description:
				"pending and running are active; succeeded, failed and superseded are final",
		}),

		progress: z
			.object({
				phase: z.enum(["queued"]),
				targetNode: z.string().optional(),
				verifiedBytes: z.number().nonnegative().optional(),
				totalBytes: z.number().nonnegative().optional(),
				queuedUntil: NullableTimestamp.optional(),
			})
			.optional()
			.openapi({
				description:
					"Portable data transfer or capacity queue progress; no credentials or request bodies",
			}),
		step: z.string().nullable().openapi({
			description: "Last completed step, for debugging; values may change",
		}),
		error: z
			.object({
				code: z.string(),
				message: z.string(),
				retryable: z.boolean(),
			})
			.nullable()
			.openapi({ description: "Why the operation failed; null otherwise" }),
		forceStop: z
			.object({
				sourceStopped: z.boolean().openapi({
					description: "The source VM was stopped by this operation",
				}),
				sourceRestarted: z
					.boolean()
					.nullable()
					.openapi({
						description:
							"The source was started again; null while that has not happened yet. " +
							"false: the restart failed (see restartError; the sandbox shows the error, " +
							"resume it), the snapshot is still good",
					}),
				restartError: z
					.object({ code: z.string(), message: z.string() })
					.nullable(),
			})
			.nullable()
			.openapi({
				description:
					"fork and save_snapshot sent with `forceStop: true` on a running Windows " +
					"sandbox: the stop and restart of the source; null otherwise",
			}),
		createdAt: Timestamp,
		startedAt: NullableTimestamp,
		finishedAt: NullableTimestamp,
	})
	.openapi("Operation", {
		description:
			"A long-running action on a sandbox; wait with GET /v1/operations/{operation}?waitSeconds=",
	});

export type OperationResource = z.infer<typeof OperationSchema>;

export const OperationQuery = z.object({
	waitSeconds: z.coerce.number().int().min(0).max(60).optional().openapi({
		description:
			"Long-poll: answer once the operation is final or after this many seconds (0-60)",
	}),
});
