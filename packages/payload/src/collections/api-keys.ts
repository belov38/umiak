import type { CollectionConfig, FieldAccess } from "payload";
import { nobody, operatorOnly } from "../access.ts";
import { jsonFieldAdmin } from "../admin-components.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";
import {
	apiKeysRevokedByBeforeChange,
	requiredOnCreate,
} from "../hooks/rules.ts";
import {
	apiKeysRevokeAfterChange,
	apiKeysRevokeAfterDelete,
} from "../hooks/ssh-revoke.ts";

// Through Payload access (/admin, REST) an operator only revokes a key
// (S8 §7): every other field is read-only there. api writes through the
// Local API with overrideAccess, which skips field access.
const readOnly: { update: FieldAccess } = { update: () => false };

// Keys are issued and rotated only by api through packages/auth (S7 §17.3):
// creation through Payload access is refused to everyone, operators too.
export const ApiKeys: CollectionConfig = {
	slug: "api-keys",
	admin: {
		useAsTitle: "name",
		defaultColumns: ["name", "team", "prefix", "expiresAt", "revokedAt"],
	},
	access: {
		read: operatorOnly,
		create: nobody,
		update: operatorOnly,
		delete: nobody,
	},
	hooks: {
		beforeChange: [apiKeysRevokedByBeforeChange],
		afterChange: [identityAfterChange("api-keys"), apiKeysRevokeAfterChange],
		afterDelete: [identityAfterDelete("api-keys"), apiKeysRevokeAfterDelete],
	},
	fields: [
		{ name: "name", type: "text", required: true, access: readOnly },
		// Nullable in the database: deleting a team keeps its revoked keys for
		// audit, with no team (S8 §6.4). Required on create.
		{
			name: "team",
			type: "relationship",
			relationTo: "teams",
			validate: requiredOnCreate,
			access: readOnly,
		},
		{
			name: "createdBy",
			type: "relationship",
			relationTo: "users",
			access: readOnly,
		},
		{
			name: "kind",
			type: "select",
			options: ["team", "sandbox"],
			required: true,
			defaultValue: "team",
			access: readOnly,
		},
		// Reserved for sandbox keys (S7 §7.2): a runtime sandbox UUID.
		{ name: "sandbox", type: "text", access: readOnly },
		// sha256 of the secret: never shown, never returned through access-checked reads.
		{
			name: "secretHash",
			type: "text",
			required: true,
			unique: true,
			access: { read: () => false, update: () => false },
			admin: { hidden: true },
		},
		{ name: "prefix", type: "text", required: true, access: readOnly },
		{ name: "last4", type: "text", required: true, access: readOnly },
		{
			name: "scopes",
			type: "json",
			required: true,
			access: readOnly,
			admin: jsonFieldAdmin,
		},
		{ name: "expiresAt", type: "date", required: true, access: readOnly },
		{
			name: "createdVia",
			type: "select",
			options: ["api", "cli", "dashboard"],
			required: true,
			access: readOnly,
		},
		{ name: "lastUsedAt", type: "date", access: readOnly },
		// Last rotation of the secret; login certificates issued before it are refused.
		{ name: "rotatedAt", type: "date", access: readOnly },
		// Set once: a revoked key stays revoked. revokedBy is set by the hook.
		{
			name: "revokedAt",
			type: "date",
			access: { update: ({ doc }) => !doc?.revokedAt },
		},
		{
			name: "revokedBy",
			type: "relationship",
			relationTo: "users",
			access: readOnly,
		},
		// The key that revoked this key (itself or another key of the team).
		{
			name: "revokedByKey",
			type: "relationship",
			relationTo: "api-keys",
			access: readOnly,
		},
	],
};
