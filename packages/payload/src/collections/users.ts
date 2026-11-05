import type { CollectionConfig } from "payload";
import { isOperatorReq, operatorOnly } from "../access.ts";
import { jsonFieldAdmin } from "../admin-components.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import {
	usersDeactivationBeforeChange,
	usersStubOnlyBeforeDelete,
} from "../hooks/rules.ts";
import {
	usersRevokeAfterChange,
	usersRevokeAfterDelete,
} from "../hooks/ssh-revoke.ts";
import { ownerStrategy } from "../identity/strategy.ts";

// Only resolveSession writes them, from the owner session (Local API,
// overrideAccess): through /admin and /cms-api the values are dropped.
const fromSession = { create: () => false, update: () => false };

const lowercase = ({ value }: { value?: unknown }) =>
	typeof value === "string" ? value.trim().toLowerCase() : value;

export const Users: CollectionConfig = {
	slug: "users",
	auth: {
		disableLocalStrategy: true,
		// The oauth2-proxy headers, on every request (S8 §5.4).
		strategies: [ownerStrategy],
	},
	admin: {
		useAsTitle: "email",
		defaultColumns: ["email", "name", "active", "isOperator", "lastLoginAt"],
	},
	access: {
		admin: ({ req }) => isOperatorReq(req),
		read: operatorOnly,
		create: operatorOnly,
		update: operatorOnly,
		// Only stubs are deletable; the hook checks it in the transaction.
		delete: operatorOnly,
	},
	hooks: {
		beforeChange: [usersDeactivationBeforeChange],
		beforeDelete: [usersStubOnlyBeforeDelete],
		afterChange: [identityAfterChange("users"), usersRevokeAfterChange],
		afterDelete: [identityAfterDelete("users"), usersRevokeAfterDelete],
	},
	fields: [
		{
			name: "email",
			type: "email",
			required: true,
			unique: true,
			hooks: { beforeValidate: [lowercase] },
		},
		{ name: "name", type: "text" },
		{
			name: "idpSubject",
			type: "text",
			unique: true,
			admin: {
				description:
					"Stable internal session subject; empty for manually created stubs.",
			},
		},
		{ name: "preferredUsername", type: "text" },
		{
			name: "groups",
			type: "json",
			access: fromSession,
			admin: {
				...jsonFieldAdmin,
				readOnly: true,
				description: "Groups of the internal owner session.",
			},
		},
		{
			name: "isOperator",
			type: "checkbox",
			defaultValue: false,
			access: fromSession,
			admin: { readOnly: true },
		},
		{ name: "active", type: "checkbox", defaultValue: true },
		{
			name: "deactivatedReason",
			type: "select",
			options: ["operator"],
		},
		{ name: "deactivatedAt", type: "date" },
		{ name: "defaultTeam", type: "relationship", relationTo: "teams" },
		{ name: "personalTeam", type: "relationship", relationTo: "teams" },
		{ name: "lastLoginAt", type: "date", admin: { readOnly: true } },
	],
};
