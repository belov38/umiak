import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";
import { jsonFieldAdmin } from "../admin-components.ts";
import { configAfterChange, configAfterDelete } from "../hooks/config.ts";
import {
	immutableSlug,
	validateAllowedSizes,
	validateDefaultSize,
} from "../hooks/rules.ts";

const SLUG_RE = /^[a-z0-9-]{1,40}$/;

export const Templates: CollectionConfig = {
	slug: "templates",
	admin: {
		useAsTitle: "slug",
		defaultColumns: [
			"slug",
			"name",
			"os",
			"enabled",
			"defaultSize",
			"sortOrder",
		],
	},
	access: operatorAccess,
	hooks: {
		afterChange: [configAfterChange("templates")],
		afterDelete: [configAfterDelete("templates")],
	},
	defaultSort: "sortOrder",
	fields: [
		{
			name: "slug",
			type: "text",
			required: true,
			unique: true,
			validate: immutableSlug(SLUG_RE, "slug: [a-z0-9-]{1,40}"),
		},
		{ name: "name", type: "text" },
		{ name: "description", type: "textarea" },
		{
			name: "os",
			type: "select",
			options: ["linux", "windows"],
			required: true,
		},
		{ name: "enabled", type: "checkbox", defaultValue: true },
		// Size slugs (S6 §5.11).
		{
			name: "defaultSize",
			type: "text",
			required: true,
			validate: validateDefaultSize,
		},
		{
			name: "allowedSizes",
			type: "json",
			required: true,
			validate: validateAllowedSizes,
			admin: jsonFieldAdmin,
		},
		{ name: "loginUser", type: "text", defaultValue: "user" },
		// S7 §13: exec, files, ssh, desktop.
		{ name: "capabilities", type: "json", admin: jsonFieldAdmin },
		{ name: "sortOrder", type: "number", defaultValue: 0 },
	],
};
