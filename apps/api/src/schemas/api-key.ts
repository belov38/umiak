// Team API keys (S7 §7.2, §13). The secret is returned only by create and
// rotate; listings carry the prefix and the last 4 characters.
import { z } from "@hono/zod-openapi";
import { SCOPES } from "@umiak/auth";
import { extensibleEnum } from "../openapi/registry.ts";
import { NO_CONTROL_CHARS, NullableTimestamp, Timestamp } from "./common.ts";

const DAY_SECONDS = 86_400;
/** S7 §7.2: 90 days by default, at most 365; no key lives forever. */
export const DEFAULT_KEY_LIFETIME_SECONDS = 90 * DAY_SECONDS;
export const MAX_KEY_LIFETIME_SECONDS = 365 * DAY_SECONDS;
const MIN_KEY_LIFETIME_SECONDS = 60;

export const KEY_PRESET_NAMES = ["read-only", "ci", "full"] as const;

export const ApiKeyParams = z.object({
	key: z.string().openapi({
		param: { name: "key", in: "path" },
		description: "API key id (`key_...`)",
		example: "key_01jbx2v7d3m6c8q9w0e4r5t6y7",
	}),
});

export const CreateApiKeyRequest = z
	.strictObject({
		name: z
			.string()
			.min(1)
			.max(100)
			.regex(NO_CONTROL_CHARS)
			.openapi({ example: "ci-main" }),
		scopes: z
			.array(
				z.enum(SCOPES, {
					error: () => `unknown scope; one of ${SCOPES.join(", ")}`,
				}),
			)
			.min(1)
			.optional()
			.openapi({ description: "Scopes of the key; or send `preset`" }),
		preset: z
			.enum(KEY_PRESET_NAMES, {
				error: () =>
					`one of ${KEY_PRESET_NAMES.join(", ")} (sandbox-self is reserved for sandbox keys)`,
			})
			.optional()
			.openapi({
				description:
					"read-only, ci or full; or send `scopes`. Exactly one of the two.",
			}),
		expiresInSeconds: z
			.int()
			.min(MIN_KEY_LIFETIME_SECONDS)
			.max(MAX_KEY_LIFETIME_SECONDS)
			.optional()
			.openapi({
				description: "Lifetime; default 90 days (7776000), at most 365 days",
			}),
		kind: z
			.enum(["team"], {
				error: () =>
					'only "team" keys can be issued; sandbox keys are reserved for a later version',
			})
			.optional()
			.openapi({ description: "Only `team` (the default)" }),
	})
	.superRefine((r, ctx) => {
		if ((r.scopes === undefined) === (r.preset === undefined)) {
			ctx.addIssue({
				code: "custom",
				path: [],
				message: "send exactly one of scopes and preset",
			});
		}
	})
	.openapi("CreateApiKeyRequest");

export const ApiKeySchema = z
	.object({
		id: z.string().openapi({ example: "key_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		kind: extensibleEnum(["team", "sandbox"]).openapi({
			description: "Always `team` in v1; `sandbox` is reserved",
		}),
		sandboxId: z
			.string()
			.nullable()
			.openapi({ description: "Sandbox keys only (reserved); null" }),
		teamId: z.string().openapi({ example: "team_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		name: z.string(),
		prefix: z.string().openapi({
			description: "First 8 characters after `umiak_`",
			example: "a1B2c3D4",
		}),
		last4: z.string().openapi({ example: "9xYz" }),
		scopes: z.array(extensibleEnum(SCOPES)),
		createdBy: z
			.object({
				id: z.string().openapi({ example: "usr_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
				email: z.string(),
				active: z
					.boolean()
					.openapi({ description: "false: the creator is deactivated" }),
				member: z.boolean().openapi({
					description: "false: the creator left the team (the key still works)",
				}),
			})
			.nullable()
			.openapi({
				description:
					"Who issued the key (audit only; the key does not depend on them)",
			}),
		createdVia: extensibleEnum(["api", "cli", "dashboard"]),
		createdAt: Timestamp,
		expiresAt: Timestamp,
		lastUsedAt: NullableTimestamp,
		revokedAt: NullableTimestamp,
	})
	.openapi("ApiKey");

export const ApiKeySecretSchema = z
	.object({
		apiKey: ApiKeySchema,
		secret: z.string().openapi({
			description:
				"The secret (`umiak_...`), shown only in this answer; keep it like a password",
		}),
	})
	.openapi("ApiKeySecret");

export const ApiKeyListSchema = z
	.object({ data: z.array(ApiKeySchema) })
	.openapi("ApiKeyList", {
		description: "Every key of the team, revoked ones included, newest first",
	});
