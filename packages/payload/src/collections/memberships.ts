import type { CollectionConfig } from "payload";
import { operatorAccess, operatorByIdOnly } from "../access.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import {
	membershipsFixedPairBeforeChange,
	membershipsLastOwnerBeforeChange,
	membershipsLastOwnerBeforeDelete,
	membershipsPersonalTeamBeforeChange,
} from "../hooks/rules.ts";
import { membershipsRevokeAfterDelete } from "../hooks/ssh-revoke.ts";

// user and team never change: a membership is replaced by delete + create,
// so the delete sends sbx_ssh_revoke for the old (team, user).
const fixed = { update: () => false };

export const Memberships: CollectionConfig = {
	slug: "memberships",
	admin: { defaultColumns: ["user", "team", "role", "createdAt"] },
	// No bulk update/delete: the last-owner rule is per document.
	access: {
		...operatorAccess,
		update: operatorByIdOnly,
		delete: operatorByIdOnly,
	},
	hooks: {
		beforeChange: [
			membershipsFixedPairBeforeChange,
			membershipsLastOwnerBeforeChange,
			membershipsPersonalTeamBeforeChange,
		],
		beforeDelete: [membershipsLastOwnerBeforeDelete],
		afterChange: [identityAfterChange("memberships")],
		afterDelete: [
			identityAfterDelete("memberships"),
			membershipsRevokeAfterDelete,
		],
	},
	indexes: [{ fields: ["user", "team"], unique: true }],
	fields: [
		{
			name: "user",
			type: "relationship",
			relationTo: "users",
			required: true,
			access: fixed,
		},
		{
			name: "team",
			type: "relationship",
			relationTo: "teams",
			required: true,
			access: fixed,
		},
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
