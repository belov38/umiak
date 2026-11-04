// GET /v1/limits (S7 §13): quota, usage and what the team may create now.
// No warm pool counts: the pool is phase 2.
import { z } from "@hono/zod-openapi";
import { extensibleEnum } from "../openapi/registry.ts";

const counters = z.object({
	activeSandboxes: z.int(),
	ramMb: z.int(),
	savedSnapshots: z.int(),
});

export const LimitsSchema = z
	.object({
		defaults: z
			.object({
				ttlSeconds: z.int().nullable(),
				stoppedRetentionDays: z.int().nullable().optional(),
				idleTimeoutSeconds: z.int().nullable(),
			})
			.optional()
			.openapi({
				description:
					"Effective platform lifecycle defaults; null disables the policy. Omitted by older servers.",
			}),
		quota: z.object({
			maxActiveSandboxes: z.int(),
			maxRamMb: z.int(),
			maxSavedSnapshots: z.int(),
		}),
		usage: counters.openapi({
			description:
				"Counted like the quota: sandboxes and their RAM while creating, ready, starting or " +
				"stopping; saved snapshots creating or ready",
		}),
		remaining: counters,
		canCreate: z.boolean().openapi({
			description: "A sandbox of at least one allowed size fits the quota now",
		}),
		templates: z.array(
			z.object({
				slug: z.string(),
				enabled: z.boolean(),
				defaultSize: z.string(),
				sizes: z.array(
					z.object({
						slug: z.string(),
						vcpu: z.int(),
						memoryMb: z.int(),
						allowed: z.boolean(),
						reason: extensibleEnum([
							"template_disabled",
							"quota_active_sandboxes",
							"quota_ram",
						])
							.nullable()
							.openapi({ description: "Why the size is not allowed now" }),
					}),
				),
			}),
		),
		rateLimits: z.object({
			requestsPerSecond: z.int(),
			burst: z.int(),
			startsPerMinute: z.int().openapi({
				description: "create, fork and resume per team",
			}),
		}),
	})
	.openapi("Limits", {
		description:
			"Quota of the request's team and what it can create; node capacity is not promised",
	});

export type Limits = z.infer<typeof LimitsSchema>;
