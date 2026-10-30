import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";

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
	defaultSort: "sortOrder",
	fields: [
		{
			name: "slug",
			type: "text",
			required: true,
			unique: true,
			validate: (v: unknown) =>
				(typeof v === "string" && SLUG_RE.test(v)) || "slug: [a-z0-9-]{1,40}",
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
		{ name: "defaultSize", type: "text", required: true },
		{ name: "allowedSizes", type: "json", required: true },
		{ name: "loginUser", type: "text", defaultValue: "user" },
		// S7 §13: exec, files, ssh, desktop.
		{ name: "capabilities", type: "json" },
		{ name: "sortOrder", type: "number", defaultValue: 0 },
	],
};
