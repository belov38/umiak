import type { CollectionConfig, Field } from "payload";
import { operatorAccess, operatorByIdOnly } from "../access.ts";
import { configAfterDelete, teamsConfigAfterChange } from "../hooks/config.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import { teamsBeforeDelete } from "../hooks/rules.ts";
import { teamsRevokeAfterDelete } from "../hooks/ssh-revoke.ts";

/** Quota fields of a team and of platform-defaults (S8 §7, S6 S3). */
export function quotaFields(): Field[] {
	return [
		{ name: "maxActiveSandboxes", type: "number", min: 0 },
		{ name: "maxRamMb", type: "number", min: 0 },
		{ name: "maxSavedSnapshots", type: "number", min: 0 },
	];
}

export const Teams: CollectionConfig = {
	slug: "teams",
	admin: {
		useAsTitle: "name",
		defaultColumns: ["name", "personal", "createdBy", "createdAt"],
	},
	// Deleted one at a time through the team page (S8 §6.4), never in bulk.
	access: { ...operatorAccess, delete: operatorByIdOnly },
	hooks: {
		beforeDelete: [teamsBeforeDelete],
		afterChange: [identityAfterChange("teams"), teamsConfigAfterChange],
		afterDelete: [
			identityAfterDelete("teams"),
			configAfterDelete("teams"),
			teamsRevokeAfterDelete,
		],
	},
	fields: [
		{ name: "name", type: "text", required: true, minLength: 1, maxLength: 64 },
		{ name: "personal", type: "checkbox", defaultValue: false },
		{ name: "createdBy", type: "relationship", relationTo: "users" },
		{
			name: "quota",
			type: "group",
			admin: {
				description:
					"Empty fields take the default quota of platform-defaults.",
			},
			fields: quotaFields(),
		},
	],
};
