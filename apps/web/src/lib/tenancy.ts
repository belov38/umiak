export type Tenancy = "single" | "teams";

/** Absent fields belong to older, team-aware deployments. Never infer from auth. */
export function metaTenancy(meta: unknown): Tenancy {
	return meta !== null &&
		typeof meta === "object" &&
		"tenancy" in meta &&
		meta.tenancy === "single"
		? "single"
		: "teams";
}
