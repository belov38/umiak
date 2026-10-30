import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";
import { configAfterChange, configAfterDelete } from "../hooks/config.ts";
import { immutableSlug, sizesInUseBeforeDelete } from "../hooks/rules.ts";

export const Sizes: CollectionConfig = {
	slug: "sizes",
	admin: {
		useAsTitle: "slug",
		defaultColumns: ["slug", "vcpu", "memoryMb", "sortOrder"],
	},
	access: operatorAccess,
	hooks: {
		beforeDelete: [sizesInUseBeforeDelete],
		afterChange: [configAfterChange("sizes")],
		afterDelete: [configAfterDelete("sizes")],
	},
	defaultSort: "sortOrder",
	fields: [
		{
			name: "slug",
			type: "text",
			required: true,
			unique: true,
			validate: immutableSlug(),
		},
		{ name: "vcpu", type: "number", required: true, min: 1 },
		{ name: "memoryMb", type: "number", required: true, min: 1 },
		{ name: "sortOrder", type: "number", defaultValue: 0 },
	],
};
