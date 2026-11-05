import { z } from "@hono/zod-openapi";
export const Quota = z
	.strictObject({
		maxActiveSandboxes: z.number().int().min(0).nullable(),
		maxRamMb: z.number().int().min(0).nullable(),
		maxSavedSnapshots: z.number().int().min(0).nullable(),
	})
	.openapi("SettingsQuota");
export const Team = z
	.object({
		id: z.string(),
		name: z.string(),
		personal: z.boolean(),
		role: z.enum(["owner", "member"]).nullable(),
		quota: Quota,
	})
	.openapi("SettingsTeam");
export const TeamCreate = z
	.strictObject({ name: z.string().trim().min(1).max(64) })
	.openapi("CreateSettingsTeam");
export const TeamPatch = TeamCreate.partial()
	.extend({ quota: Quota.partial().optional() })
	.strict()
	.openapi("UpdateSettingsTeam");
export const Session = z
	.object({
		user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
		teams: z.array(Team),
		defaultTeamId: z.string(),
		isOperator: z.boolean(),
	})
	.openapi("SettingsSession");
export const Slug = z.string().regex(/^[a-z0-9-]{1,40}$/);
export const TemplateCreate = z
	.strictObject({
		slug: Slug,
		name: z.string().max(128).nullable().optional(),
		description: z.string().max(4096).nullable().optional(),
		os: z.enum(["linux", "windows"]),
		enabled: z.boolean().default(true),
		defaultSize: Slug,
		allowedSizes: z.array(Slug).min(1).max(100),
		loginUser: z.string().min(1).max(64).nullable().optional(),
		capabilities: z
			.array(z.enum(["exec", "files", "ssh", "desktop"]))
			.nullable()
			.optional(),
		sortOrder: z.number().int().optional(),
	})
	.openapi("CreateSettingsTemplate");
export const TemplatePatch = TemplateCreate.omit({ slug: true })
	.partial()
	.extend({
		enabled: z.boolean().nullable().optional(),
		sortOrder: z.number().int().nullable().optional(),
	})
	.strict()
	.openapi("UpdateSettingsTemplate");
export const Template = z
	.object({
		slug: Slug,
		name: z.string().nullable(),
		description: z.string().nullable(),
		os: z.enum(["linux", "windows"]),
		enabled: z.boolean().nullable(),
		defaultSize: z.string(),
		allowedSizes: z.array(z.string()),
		loginUser: z.string().nullable(),
		capabilities: z.array(z.string()).nullable(),
		sortOrder: z.number().nullable(),
	})
	.openapi("SettingsTemplate");
export const SizeCreate = z
	.strictObject({
		slug: Slug,
		vcpu: z.number().int().min(1).max(256),
		memoryMb: z.number().int().min(1).max(1048576),
		sortOrder: z.number().int().optional(),
	})
	.openapi("CreateSettingsSize");
export const SizePatch = SizeCreate.omit({ slug: true })
	.partial()
	.extend({ sortOrder: z.number().int().nullable().optional() })
	.strict()
	.openapi("UpdateSettingsSize");
export const Size = z
	.object({
		slug: Slug,
		vcpu: z.number(),
		memoryMb: z.number(),
		sortOrder: z.number().nullable(),
	})
	.openapi("SettingsSize");
export const Defaults = z
	.strictObject({
		ttlSeconds: z.number().int().min(1).nullable(),
		maxTtlSeconds: z.number().int().min(1),
		idleTimeoutSeconds: z.number().int().min(1).nullable(),
		stoppedRetentionDays: z.number().int().min(1).nullable(),
		errorRetentionDays: z.number().int().min(1),
		recoverMinIntervalSeconds: z.number().int().min(0),
		defaultTemplate: Slug,
		publicPortsEnabled: z.boolean().nullable(),
		publicDesktopEnabled: z.boolean().nullable(),
		rateLimits: z.strictObject({
			requestsPerSecond: z.number().int().min(1).nullable(),
			burst: z.number().int().min(1).nullable(),
			startsPerMinute: z.number().int().min(1).nullable(),
		}),
		defaultQuota: Quota,
		newSharedTeamQuota: Quota,
		maxOwnedTeamsPerUser: z.number().int().min(0).nullable(),
	})
	.openapi("SettingsPlatformDefaults");
export const Ok = z
	.object({ ok: z.literal(true) })
	.openapi("SettingsMutationResult");
