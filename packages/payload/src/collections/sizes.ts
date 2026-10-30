import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";

export const Sizes: CollectionConfig = {
	slug: "sizes",
	admin: {
		useAsTitle: "slug",
		defaultColumns: ["slug", "vcpu", "memoryMb", "sortOrder"],
	},
	access: operatorAccess,
	defaultSort: "sortOrder",
	fields: [
		{ name: "slug", type: "text", required: true, unique: true },
		{ name: "vcpu", type: "number", required: true, min: 1 },
		{ name: "memoryMb", type: "number", required: true, min: 1 },
		{ name: "sortOrder", type: "number", defaultValue: 0 },
	],
};
