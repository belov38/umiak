// Sandbox resource and the bodies of the sandbox routes (S7 §8.1, §8.2).
import { z } from "@hono/zod-openapi";
import {
	BLOCK_NOTE_MAX_CHARS,
	BLOCK_REASONS,
	SANDBOX_STATES,
} from "@umiak/core";
import { extensibleEnum } from "../openapi/registry.ts";
import {
	EnvPatchFields,
	EnvVars,
	ForceStopField,
	IdleTimeoutSeconds,
	Labels,
	NullableTimestamp,
	PageQuery,
	SecretFileInputs,
	Timestamp,
	TtlSeconds,
} from "./common.ts";
import { OperationSchema } from "./operation.ts";

export const SandboxStateSchema = extensibleEnum(SANDBOX_STATES).openapi(
	"SandboxState",
	{
		description:
			"`ready` means usable; creating, stopping, stopped, starting, error, deleting, deleted",
	},
);

const REASONS = BLOCK_REASONS as readonly ["operator", "abuse"];

/** Why a platform operator blocked a sandbox or a port; inline (not a component). */
export const BlockReasonSchema = extensibleEnum(REASONS);

export const SandboxSchema = z
	.object({
		id: z.string().openapi({ example: "sb_01jbx4q3m7f8r2t6v9w0y1z2a3" }),
		slug: z.string().openapi({
			description: "Name in port URLs, SSH and the guest hostname",
			example: "quiet-otter-lamp",
		}),
		name: z.string().nullable(),
		teamId: z.string().openapi({ example: "team_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		createdBy: z.string().nullable().openapi({
			description: "The person (`usr_...`); null when a team key created it",
		}),
		createdByKey: z.string().nullable().openapi({
			description: "The team key (`key_...`) that created it, else null",
		}),
		template: z.string().openapi({ example: "linux" }),
		templateVersion: z.string().nullable().openapi({
			description: "Version of the template build the sandbox runs",
		}),
		size: z.string().openapi({ example: "2gb" }),
		vcpu: z.int(),
		memoryMb: z.int(),
		state: SandboxStateSchema,
		health: extensibleEnum(["ok", "degraded"]).openapi({
			description:
				"degraded: the agent is not reachable; calls wait up to 30 s and give 503 agent_unavailable",
		}),
		healthReason: z.string().nullable(),
		degradedSince: NullableTimestamp,
		activity: extensibleEnum(["busy", "idle", "unknown"]),
		lastActivityAt: NullableTimestamp,
		stopReason: extensibleEnum([
			"user",
			"ttl",
			"idle",
			"unexpected_shutdown",
			"retention",
		])
			.nullable()
			.openapi({ description: "Why the sandbox stopped" }),
		error: z
			.object({ code: z.string(), message: z.string() })
			.nullable()
			.openapi({
				description:
					"Why the sandbox is in `error` (create_failed, resume_failed, machine_lost, ...)",
			}),
		origin: z
			.object({
				kind: extensibleEnum(["template", "snapshot", "fork"]),
				snapshot: z.string().nullable().optional().openapi({
					description:
						"kind snapshot: name of the saved snapshot (null once it is deleted)",
				}),
				snapshotId: z.string().optional().openapi({
					description: "kind snapshot: `snap_...`",
				}),
				sandboxId: z.string().optional().openapi({
					description: "kind fork: the source sandbox `sb_...`",
				}),
			})
			.openapi({ description: "What the sandbox was created from" }),
		labels: Labels,
		ttlSeconds: z.int().nullable(),
		deadlineAt: NullableTimestamp.openapi({
			description: "When the TTL deletes the sandbox; null without a TTL",
		}),
		idleTimeoutSeconds: z.int().nullable(),
		// A union, not `.nullable()`: zod-openapi would mark the registered
		// Operation component itself nullable.
		activeOperation: z.union([OperationSchema, z.null()]).openapi({
			description: "The running operation, or null",
		}),
		endpoints: z.object({
			desktop: z.string().optional(),
			portUrlTemplate: z.string().openapi({
				description: "URL of a published port; replace {port}",
				example: "https://quiet-otter-lamp-{port}.umiak.example.com",
			}),
			ssh: z.string().openapi({
				description: "SSH command (needs a certificate or a registered key)",
				example: "ssh quiet-otter-lamp@ssh.example.com",
			}),
		}),
		environment: z
			.object({ id: z.string(), name: z.string(), revision: z.int() })
			.nullable()
			.openapi({
				description: "Environment the sandbox was created from",
			}),
		excludeOwnerSecrets: z.boolean(),
		blocked: z.boolean().openapi({
			description:
				"A platform operator blocked the sandbox: its ports are refused and only reads, " +
				"stop and delete are allowed (403 `forbidden`, details.reason `sandbox_blocked`)",
		}),
		blockReason: BlockReasonSchema.nullable().openapi({
			description: "Why it is blocked; null unless blocked",
		}),
		createdAt: Timestamp,
		readyAt: NullableTimestamp,
		stoppedAt: NullableTimestamp,
		deletedAt: NullableTimestamp,
		updatedAt: Timestamp,
	})
	.openapi("Sandbox", {
		description:
			"A VM sandbox. Work with it while `state` is `ready`; deleted sandboxes stay readable for 30 days",
	});

export type SandboxResource = z.infer<typeof SandboxSchema>;

export const SandboxListSchema = z
	.object({
		data: z.array(SandboxSchema),
		nextCursor: z.string().nullable().openapi({
			description: "Cursor of the next page; null on the last page",
		}),
	})
	.openapi("SandboxList");

export const SandboxActionSchema = z
	.object({ sandbox: SandboxSchema, operation: OperationSchema })
	.openapi("SandboxAction", {
		description: "The sandbox now and the operation that was started",
	});

export const SandboxDeleteSchema = z
	.object({
		sandbox: SandboxSchema,
		operation: z.union([OperationSchema, z.null()]).openapi({
			description: "The delete operation; null when it was already deleted",
		}),
	})
	.openapi("SandboxDelete", {
		description:
			"The sandbox and its delete operation; operation is null when it was already deleted",
	});

export const SandboxForkSchema = z
	.object({
		sandbox: SandboxSchema.openapi({ description: "The new sandbox" }),
		operation: OperationSchema.openapi({
			description: "`create` of the new sandbox",
		}),
		sourceOperation: OperationSchema.openapi({
			description: "`fork` on the source sandbox",
		}),
	})
	.openapi("SandboxFork");

// --- requests ---

const nameField = z.string().max(255).nullable().optional().openapi({
	description: "Display name, up to 255 characters",
	example: "ci-run-42",
});

const slugField = z.string().optional().openapi({
	description:
		"3-40 characters `[a-z0-9]+(-[a-z0-9]+)*`, not ending in -<digits>; default: three random words",
	example: "my-box",
});

export const CreateSandboxRequest = z
	.strictObject({
		template: z.string().optional().openapi({
			description:
				"Template slug (GET /v1/templates); `windows-desktop` is a compatibility alias for `windows`; ignored with `from`",
			example: "linux",
		}),
		size: z.string().optional().openapi({
			description: "Size slug; default: the template's default size",
			example: "2gb",
		}),
		name: nameField,
		slug: slugField,
		labels: Labels.optional(),
		env: EnvVars.optional(),
		secrets: EnvVars.optional().openapi({
			description: "Secret variables: on tmpfs in the guest, never returned",
		}),
		secretFiles: SecretFileInputs.optional(),
		ttlSeconds: TtlSeconds.optional(),
		idleTimeoutSeconds: IdleTimeoutSeconds.optional(),
		from: z
			.strictObject({
				snapshot: z.string().openapi({ example: "web-stack" }),
			})
			.optional()
			.openapi({
				description:
					"Create from a saved snapshot of the team (needs snapshots:read)",
			}),
		environment: z
			.string()
			.nullable()
			.optional()
			.openapi({
				description:
					"Environment name or `env_...` (needs environments:read); absent: the team's default " +
					"environment; null: none. Its sets are applied first, the request's sets on top",
				example: "base",
			}),
		excludeOwnerSecrets: z
			.boolean()
			.optional()
			.openapi({
				description:
					"Do not pass the creator's personal secrets into the sandbox. Only false " +
					"is accepted for now: true is 400 until sandboxes store the flag",
			}),
	})
	.openapi("CreateSandboxRequest");

export const UpdateSandboxRequest = z
	.strictObject({
		name: nameField,
		slug: z.string().optional().openapi({
			description:
				"New slug; published port URLs and their cookies change at once",
		}),
		labels: Labels.optional().openapi({ description: "Replaces all labels" }),
		ttlSeconds: TtlSeconds.optional().openapi({
			description:
				"New TTL: deadline = now + ttl on a ready sandbox; null removes it",
		}),
		idleTimeoutSeconds: IdleTimeoutSeconds.optional(),
	})
	.openapi("UpdateSandboxRequest");

export const ResumeSandboxRequest = z
	.strictObject({
		size: z.string().optional().openapi({
			description: "Another size allowed for the template",
		}),
		ttlSeconds: TtlSeconds.optional(),
		...EnvPatchFields,
	})
	.openapi("ResumeSandboxRequest", {
		description:
			"Sets merge onto the sandbox's own and are stored even if the resume fails",
	});

export const ForkSandboxRequest = z
	.strictObject({
		name: nameField,
		slug: slugField,
		labels: Labels.optional().openapi({
			description: "Default: the source's labels",
		}),
		ttlSeconds: TtlSeconds.optional(),
		idleTimeoutSeconds: IdleTimeoutSeconds.optional(),
		size: z.string().optional().openapi({
			description: "Default: the source's size",
		}),
		forceStop: ForceStopField,
		...EnvPatchFields,
	})
	.openapi("ForkSandboxRequest", {
		description:
			"Sets merge onto a copy of the source's sets; the source is not changed",
	});

export const ExtendSandboxRequest = z
	.strictObject({
		ttlSeconds: z.int().positive().optional().openapi({
			description:
				"New deadline = now + ttlSeconds; default: the sandbox's TTL",
		}),
	})
	.openapi("ExtendSandboxRequest");

// --- operator blocks (S8 C3) ---

const BlockNote = z
	.string()
	.max(BLOCK_NOTE_MAX_CHARS)
	.optional()
	.openapi({
		description: `Up to ${BLOCK_NOTE_MAX_CHARS} characters for the record (the sandbox's events)`,
	});

export const BlockRequest = z
	.strictObject({
		reason: z.enum(REASONS),
		note: BlockNote,
	})
	.openapi("BlockRequest");

export const UnblockRequest = z
	.strictObject({ note: BlockNote })
	.openapi("UnblockRequest");

// --- queries ---

export const ListSandboxesQuery = z.object({
	state: z.string().optional().openapi({
		description:
			"Comma-separated states; default: all but deleted (deleted only when asked)",
		example: "ready,stopped",
	}),
	label: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.openapi({
			description: "`key=value`; repeat for several (all must match)",
			example: "session=42",
		}),
	template: z.string().optional(),
	q: z.string().optional().openapi({
		description: "Prefix of the name or slug, case-insensitive",
	}),
	allTeams: z
		.enum(["true", "false"])
		.optional()
		.openapi({
			description:
				"`true`: sandboxes of every team. Only a platform operator in the dashboard " +
				"(browser session); anyone else is 403 `forbidden` (details.reason `operator_required`)",
		}),
	teamId: z.string().optional().openapi({
		description: "With allTeams=true: only this team (`team_...`)",
		example: "team_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
	...PageQuery,
});

export const GetSandboxQuery = z.object({
	waitFor: z
		.string()
		.optional()
		.openapi({
			description:
				"Long-poll: comma-separated states; answers once the state is one of them or " +
				"error/deleting/deleted, else after waitSeconds",
			example: "ready",
		}),
	waitSeconds: z.coerce.number().int().min(0).max(60).optional().openapi({
		description: "Long-poll timeout, 0-60 seconds (default 30 with waitFor)",
	}),
});
