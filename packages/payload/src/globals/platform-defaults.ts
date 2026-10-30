import type { GlobalConfig } from "payload";
import { operatorOnly } from "../access.ts";
import { quotaFields } from "../collections/teams.ts";

// Platform defaults (S6 §5.11, S7, S8 §7). The values are seeded by the
// initial migration; the defaultValue of every field matches the seed.
export const PlatformDefaults: GlobalConfig = {
	slug: "platform-defaults",
	access: { read: operatorOnly, update: operatorOnly },
	fields: [
		// S6
		{ name: "ttlSeconds", type: "number", min: 1 },
		{
			name: "maxTtlSeconds",
			type: "number",
			min: 1,
			required: true,
			defaultValue: 604800,
		},
		{ name: "idleTimeoutSeconds", type: "number", min: 1, defaultValue: 900 },
		{ name: "stoppedRetentionDays", type: "number", min: 1 },
		{
			name: "errorRetentionDays",
			type: "number",
			min: 1,
			required: true,
			defaultValue: 7,
		},
		{
			name: "recoverMinIntervalSeconds",
			type: "number",
			min: 0,
			required: true,
			defaultValue: 600,
		},
		// S7
		{
			name: "defaultTemplate",
			type: "text",
			required: true,
			defaultValue: "linux",
		},
		{ name: "publicPortsEnabled", type: "checkbox", defaultValue: true },
		{
			name: "ssoPortPolicy",
			type: "select",
			options: ["any", "team"],
			required: true,
			defaultValue: "any",
		},
		{
			name: "rateLimits",
			type: "group",
			fields: [
				{ name: "requestsPerSecond", type: "number", min: 1, defaultValue: 20 },
				{ name: "burst", type: "number", min: 1, defaultValue: 100 },
				{ name: "startsPerMinute", type: "number", min: 1, defaultValue: 30 },
			],
		},
		// S8
		{
			name: "defaultQuota",
			type: "group",
			admin: {
				description: "Personal teams and empty quota fields of a team.",
			},
			fields: quotaFields(),
		},
		{
			name: "newSharedTeamQuota",
			type: "group",
			admin: { description: "Copied into the quota of a new shared team." },
			fields: quotaFields(),
		},
		{ name: "maxOwnedTeamsPerUser", type: "number", min: 0, defaultValue: 3 },
		// Bumped when ssoPortPolicy changes (S8 §8).
		{
			name: "ssoPolicyEpoch",
			type: "number",
			min: 0,
			defaultValue: 0,
			admin: { readOnly: true },
		},
	],
};
