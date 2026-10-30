import type { CollectionConfig } from "payload";
import { nobody, operatorOnly } from "../access.ts";

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
	fields: [
		{ name: "name", type: "text", required: true },
		{ name: "team", type: "relationship", relationTo: "teams", required: true },
		{ name: "createdBy", type: "relationship", relationTo: "users" },
		{
			name: "kind",
			type: "select",
			options: ["team", "sandbox"],
			required: true,
			defaultValue: "team",
		},
		// Reserved for sandbox keys (S7 §7.2): a runtime sandbox UUID.
		{ name: "sandbox", type: "text" },
		// sha256 of the secret: never shown, never returned through access-checked reads.
		{
			name: "secretHash",
			type: "text",
			required: true,
			unique: true,
			access: { read: () => false },
			admin: { hidden: true },
		},
		{ name: "prefix", type: "text", required: true },
		{ name: "last4", type: "text", required: true },
		{ name: "scopes", type: "json", required: true },
		{ name: "expiresAt", type: "date", required: true },
		{
			name: "createdVia",
			type: "select",
			options: ["api", "cli", "dashboard"],
			required: true,
		},
		{ name: "lastUsedAt", type: "date" },
		// Last rotation of the secret; login certificates issued before it are refused.
		{ name: "rotatedAt", type: "date" },
		{ name: "revokedAt", type: "date" },
		{ name: "revokedBy", type: "relationship", relationTo: "users" },
		// The key that revoked this key (itself or another key of the team).
		{ name: "revokedByKey", type: "relationship", relationTo: "api-keys" },
	],
};
