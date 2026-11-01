// Saved snapshots (S7 §13): addressed by name within the team.
import { z } from "@hono/zod-openapi";
import { extensibleEnum } from "../openapi/registry.ts";
import { ForceStopField, NullableTimestamp, Timestamp } from "./common.ts";
import { OperationSchema } from "./operation.ts";

export const SNAPSHOT_NAME_PATTERN = "^[a-z0-9][a-z0-9-]{0,62}$";

const SnapshotName = z
	.string()
	.regex(new RegExp(SNAPSHOT_NAME_PATTERN))
	.openapi({
		description: "Name within the team: `^[a-z0-9][a-z0-9-]{0,62}$`",
		example: "web-stack",
	});

export const SnapshotParams = z.object({
	name: z.string().openapi({
		param: { name: "name", in: "path" },
		description: "Name of the saved snapshot",
		example: "web-stack",
	}),
});

export const CreateSnapshotRequest = z
	.strictObject({
		sandbox: z.string().min(1).openapi({
			description: "Source sandbox: id (`sb_...`) or slug",
			example: "quiet-otter-lamp",
		}),
		name: SnapshotName,
		forceStop: ForceStopField,
	})
	.openapi("CreateSnapshotRequest", {
		description:
			"A ready snapshot with this name is replaced once the new one is ready",
	});

export const SnapshotSchema = z
	.object({
		id: z.string().openapi({ example: "snap_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		name: z.string().openapi({
			description: "The name; while creating, the name it will get",
			example: "web-stack",
		}),
		state: extensibleEnum(["creating", "ready", "failed", "deleting"]),
		sourceSandboxId: z.string().nullable().openapi({
			description: "The sandbox it was taken from (`sb_...`)",
		}),
		template: z.string().nullable(),
		templateVersion: z.string().nullable(),
		size: z.string().nullable().openapi({ example: "2gb" }),
		consistency: extensibleEnum(["quiesced", "powered_off", "crash"])
			.nullable()
			.openapi({
				description:
					"quiesced: filesystems frozen in a running VM; powered_off: taken from a " +
					"VM stopped by a clean guest shutdown; crash: disks as after a power loss " +
					"(a Linux VM after a hard stop, or an older Windows snapshot); null until ready",
			}),
		error: z
			.object({ code: z.string(), message: z.string() })
			.nullable()
			.openapi({ description: "Why it failed; null otherwise" }),
		createdAt: Timestamp,
		readyAt: NullableTimestamp,
	})
	.openapi("Snapshot", {
		description:
			"A saved snapshot; create a sandbox from it with POST /v1/sandboxes {from: {snapshot: name}}",
	});

export type SnapshotResource = z.infer<typeof SnapshotSchema>;

export const SnapshotListSchema = z
	.object({
		data: z.array(SnapshotSchema).openapi({
			description:
				"Ready and creating snapshots and those that failed within a day, newest first",
		}),
	})
	.openapi("SnapshotList");

export const SnapshotCreateSchema = z
	.object({ snapshot: SnapshotSchema, operation: OperationSchema })
	.openapi("SnapshotCreate", {
		description:
			"The new snapshot (creating) and the save_snapshot operation of the source sandbox",
	});
