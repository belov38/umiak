import type { GlobalConfig } from "payload";
import { operatorOnly } from "../access.ts";
import { quotaFields } from "../collections/teams.ts";
import { platformDefaultsConfigAfterChange } from "../hooks/config.ts";
import {
	routesAfterChange,
	ssoPolicyEpochBeforeChange,
} from "../hooks/routes.ts";

// Platform defaults (S6 §5.11, S7, S8 §7). The values are seeded by the
// initial migration. Retention defaults below preserve legacy behavior when
// reading old installs; only the fresh database seed enables 24-hour retention.
export const PlatformDefaults: GlobalConfig = {
	slug: "platform-defaults",
	access: { read: operatorOnly, update: operatorOnly },
	hooks: {
		beforeChange: [ssoPolicyEpochBeforeChange],
		afterChange: [platformDefaultsConfigAfterChange, routesAfterChange],
	},
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
		{
			name: "stoppedRetentionDays",
			type: "number",
			min: 1,
			admin: {
				description:
					"Days after stopping before full deletion. Blank disables it. New installs: 1 day (24 h). Saved snapshots are kept.",
			},
		},
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
		{ name: "publicDesktopEnabled", type: "checkbox", defaultValue: false },
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
		// Owned by the beforeChange hook: +1 when ssoPortPolicy goes from any
		// to team (S8 §8); written values are ignored.
		{
			name: "ssoPolicyEpoch",
			type: "number",
			min: 0,
			defaultValue: 0,
			admin: { readOnly: true },
		},
	],
};
