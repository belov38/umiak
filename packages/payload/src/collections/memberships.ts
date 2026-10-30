import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import {
	membershipsLastOwnerBeforeChange,
	membershipsLastOwnerBeforeDelete,
} from "../hooks/rules.ts";
import { membershipsRevokeAfterDelete } from "../hooks/ssh-revoke.ts";

export const Memberships: CollectionConfig = {
	slug: "memberships",
	admin: { defaultColumns: ["user", "team", "role", "createdAt"] },
	access: operatorAccess,
	hooks: {
		beforeChange: [membershipsLastOwnerBeforeChange],
		beforeDelete: [membershipsLastOwnerBeforeDelete],
		afterChange: [identityAfterChange("memberships")],
		afterDelete: [
			identityAfterDelete("memberships"),
			membershipsRevokeAfterDelete,
		],
	},
	indexes: [{ fields: ["user", "team"], unique: true }],
	fields: [
		{ name: "user", type: "relationship", relationTo: "users", required: true },
		{ name: "team", type: "relationship", relationTo: "teams", required: true },
		{
			name: "role",
			type: "select",
			options: ["owner", "member"],
			required: true,
			defaultValue: "member",
		},
		{ name: "invitedBy", type: "relationship", relationTo: "users" },
	],
};
