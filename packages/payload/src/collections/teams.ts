import type { CollectionConfig, Field } from "payload";
import { operatorAccess, teamDeleteAccess } from "../access.ts";
import { DELETE_TEAM_COMPONENT } from "../admin-components.ts";
import { configAfterDelete, teamsConfigAfterChange } from "../hooks/config.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import {
	teamsBeforeDelete,
	teamsPersonalFixedBeforeChange,
} from "../hooks/rules.ts";
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
		// The only way to delete a team (S8 §6.4): checks the runtime first.
		components: { edit: { beforeDocumentControls: [DELETE_TEAM_COMPONENT] } },
	},
	// Deleted one at a time through the "Delete team" button of the team
	// page (S8 §6.4), never in bulk and not with Payload's own Delete.
	access: { ...operatorAccess, delete: teamDeleteAccess },
	hooks: {
		beforeChange: [teamsPersonalFixedBeforeChange],
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
