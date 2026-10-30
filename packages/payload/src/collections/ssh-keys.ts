import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";
import { identityAfterChange, identityAfterDelete } from "../hooks/identity.ts";

export const SshKeys: CollectionConfig = {
	slug: "ssh-keys",
	admin: {
		useAsTitle: "name",
		defaultColumns: ["name", "user", "type", "fingerprint", "lastUsedAt"],
	},
	access: operatorAccess,
	hooks: {
		afterChange: [identityAfterChange("ssh-keys")],
		afterDelete: [identityAfterDelete("ssh-keys")],
	},
	fields: [
		{ name: "user", type: "relationship", relationTo: "users", required: true },
		{ name: "name", type: "text", required: true },
		{ name: "publicKey", type: "textarea", required: true },
		{ name: "fingerprint", type: "text", required: true, unique: true },
		{ name: "type", type: "text", required: true },
		{ name: "lastUsedAt", type: "date" },
	],
};
