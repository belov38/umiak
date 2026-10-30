import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";

// Written by the IdP sync (S8 §20.1); owners of the team acknowledge them
// through a server action.
export const TeamNotices: CollectionConfig = {
	slug: "team-notices",
	admin: {
		defaultColumns: ["team", "kind", "user", "createdAt", "acknowledgedAt"],
	},
	access: operatorAccess,
	fields: [
		{ name: "team", type: "relationship", relationTo: "teams", required: true },
		{
			name: "kind",
			type: "select",
			options: ["member_deactivated"],
			required: true,
		},
		{ name: "user", type: "relationship", relationTo: "users" },
		// [{id, name, prefix}] of the team keys the user created.
		{ name: "apiKeys", type: "json" },
		{ name: "acknowledgedBy", type: "relationship", relationTo: "users" },
		{ name: "acknowledgedAt", type: "date" },
	],
};
