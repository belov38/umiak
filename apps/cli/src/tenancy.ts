// Deployment presentation comes from anonymous server metadata, independently of
// credentials. Old servers omit tenancy and retain the established team output.
import { withFileLock } from "./auth/lock.ts";
import { type Profile, readConfig, writeConfig } from "./config.ts";
import type { Context } from "./context.ts";
import { type Resolved, sameApi } from "./profile.ts";

export type Tenancy = "single" | "teams";
export const TENANCY_CACHE_MS = 24 * 60 * 60 * 1000;
export function tenancyOf(meta: { tenancy?: unknown }): Tenancy {
	return meta.tenancy === "single" ? "single" : "teams";
}
export function tenancyCache(meta: {
	tenancy?: unknown;
}): Pick<Profile, "tenancy" | "tenancyCheckedAt"> {
	return { tenancy: tenancyOf(meta), tenancyCheckedAt: Date.now() };
}
/** Offline display, including help; never apply another deployment's profile. */
export function cachedTenancy(resolved: Resolved): Tenancy {
	return resolved.profile &&
		resolved.apiUrl &&
		sameApi(resolved.apiUrl, resolved.profile.apiUrl)
		? tenancyOf(resolved.profile)
		: "teams";
}
const requests = new WeakMap<Context, Promise<Tenancy>>();
export function deploymentTenancy(ctx: Context): Promise<Tenancy> {
	const pending = requests.get(ctx);
	if (pending) return pending;
	const refresh = async (): Promise<Tenancy> => {
		const resolved = ctx.resolved;
		const profile = resolved.profile;
		const cached = cachedTenancy(resolved);
		const matches =
			profile !== undefined &&
			resolved.apiUrl !== undefined &&
			sameApi(resolved.apiUrl, profile.apiUrl);
		if (
			matches &&
			(profile.tenancy === "single" || profile.tenancy === "teams") &&
			typeof profile.tenancyCheckedAt === "number" &&
			Date.now() - profile.tenancyCheckedAt >= 0 &&
			Date.now() - profile.tenancyCheckedAt < TENANCY_CACHE_MS
		)
			return cached;
		try {
			const reply = await ctx.fetch(
				new Request(`${ctx.apiUrl()}/v1/meta`, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(3000),
				}),
			);
			if (!reply.ok) return cached;
			const meta = (await reply.json()) as { tenancy?: unknown };
			const patch = tenancyCache(meta);
			if (matches) {
				// Preserve concurrent profile/credential changes: update only these fields.
				await withFileLock(ctx.paths.lock, async () => {
					const config = readConfig(ctx.paths);
					const current = config.profiles[resolved.profileName];
					if (current && sameApi(current.apiUrl, profile.apiUrl)) {
						Object.assign(current, patch);
						writeConfig(ctx.paths, config);
					}
				}).catch(() => {
					// A read-only config must not discard fresh deployment metadata.
				});
				Object.assign(profile, patch);
			}
			return tenancyOf(meta);
		} catch {
			// Display remains usable offline. Unknown deployments use legacy team output.
			return cached;
		}
	};
	const promise = refresh();
	requests.set(ctx, promise);
	return promise;
}
type AccountPresentation<T extends object> = Omit<
	T,
	"team" | "teams" | "teamId" | "teamName"
> & {
	team?: T extends { team: infer Team } ? Team : never;
};
/** Project CLI output only; the SDK resource and API contract remain intact. */
export function presentAccount<T extends object>(
	value: T,
	tenancy: Tenancy,
): AccountPresentation<T> {
	if (tenancy === "teams") return value;
	const {
		team: _team,
		teams: _teams,
		teamId: _id,
		teamName: _name,
		...rest
	} = value as T & {
		team?: unknown;
		teams?: unknown;
		teamId?: unknown;
		teamName?: unknown;
	};
	return rest as AccountPresentation<T>;
}
