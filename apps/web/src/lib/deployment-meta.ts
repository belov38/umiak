import "server-only";
import { cache } from "react";
import { metaTenancy } from "./tenancy";

/** The anonymous backend metadata is the shared CLI/dashboard tenancy authority. */
export const getDeploymentMeta = cache(async () => {
	try {
		const response = await fetch(
			process.env.UMIAK_WEB_META_URL ?? "http://web-meta:8080/v1/meta",
			{
				cache: "no-store",
				redirect: "error",
				signal: AbortSignal.timeout(3000),
			},
		);
		if (!response.ok) return { tenancy: "teams" as const };
		return { tenancy: metaTenancy(await response.json()) };
	} catch {
		return { tenancy: "teams" as const };
	}
});
