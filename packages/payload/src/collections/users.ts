import type { CollectionConfig } from "payload";
import { isOperatorReq, operatorOnly } from "../access.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import { usersStubOnlyBeforeDelete } from "../hooks/rules.ts";
import {
	usersRevokeAfterChange,
	usersRevokeAfterDelete,
} from "../hooks/ssh-revoke.ts";
import { oauth2ProxyStrategy } from "../identity/strategy.ts";

const lowercase = ({ value }: { value?: unknown }) =>
	typeof value === "string" ? value.trim().toLowerCase() : value;

export const Users: CollectionConfig = {
	slug: "users",
	auth: {
		disableLocalStrategy: true,
		// The oauth2-proxy headers, on every request (S8 §5.4).
		strategies: [oauth2ProxyStrategy],
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
					"`sub` of the IdP; empty for stubs. Clear it to let a new IdP account take over this user.",
			},
		},
		{ name: "preferredUsername", type: "text" },
		{
			name: "groups",
			type: "json",
			admin: { readOnly: true, description: "Last groups from the IdP." },
		},
		{
			name: "isOperator",
			type: "checkbox",
			defaultValue: false,
			admin: { readOnly: true },
		},
		{ name: "active", type: "checkbox", defaultValue: true },
		{
			name: "deactivatedReason",
			type: "select",
			options: ["operator", "idp_disabled", "idp_deleted"],
		},
		{ name: "deactivatedAt", type: "date" },
		{ name: "defaultTeam", type: "relationship", relationTo: "teams" },
		{ name: "personalTeam", type: "relationship", relationTo: "teams" },
		{ name: "lastLoginAt", type: "date", admin: { readOnly: true } },
	],
};
