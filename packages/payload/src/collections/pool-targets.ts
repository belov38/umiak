import type { CollectionConfig } from "payload";
import { operatorAccess } from "../access.ts";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PoolTargets: CollectionConfig = {
	slug: "pool-targets",
	admin: { defaultColumns: ["template", "size", "providerId", "target"] },
	access: operatorAccess,
	indexes: [{ fields: ["template", "size", "providerId"], unique: true }],
	fields: [
		// Template and size slugs.
		{ name: "template", type: "text", required: true },
		{ name: "size", type: "text", required: true },
		// A runtime provider (S6 `providers`); the topology lives in runtime,
		// so it is entered as text.
		{
			name: "providerId",
			type: "text",
			validate: (v: unknown) =>
				v == null || v === "" || (typeof v === "string" && UUID_RE.test(v))
					? true
					: "providerId must be a UUID",
		},
		{ name: "target", type: "number", required: true, min: 0, max: 50 },
		{ name: "maxAgeHours", type: "number", min: 1 },
	],
};
