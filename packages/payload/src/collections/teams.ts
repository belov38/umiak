import type { CollectionConfig, Field } from "payload";
import { operatorAccess } from "../access.ts";

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
	access: operatorAccess,
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
