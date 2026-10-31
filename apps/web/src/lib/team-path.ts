// Team part of /app URLs (S8 §9.2, §9.3): /app/t/<team_...>/<section>/...

/** Team sections that exist in every team; deeper paths (a sandbox) do not. */
export const TEAM_SECTIONS = [
	"snapshots",
	"environments",
	"keys",
	"settings",
] as const;

export function teamPath(teamId: string, section?: string): string {
	return section ? `/app/t/${teamId}/${section}` : `/app/t/${teamId}`;
}

/**
 * The same page in another team: the section is kept, anything bound to
 * the old team (a sandbox, a form) goes to the team's start page.
 */
export function switchTeamPath(pathname: string, teamId: string): string {
	const m = /^\/app\/t\/[^/]+(?:\/([^/]+))?/.exec(pathname);
	const section = m?.[1];
	return teamPath(
		teamId,
		section !== undefined &&
			(TEAM_SECTIONS as readonly string[]).includes(section)
			? section
			: undefined,
	);
}

/** The sign-out link: oauth2-proxy, then the IdP logout page if configured (S8 §5.4). */
export function signOutHref(logoutUrl: string | null): string {
	return logoutUrl === null
		? "/oauth2/sign_out"
		: `/oauth2/sign_out?rd=${encodeURIComponent(logoutUrl)}`;
}
