// Which profile, API and team a command uses (S7 §14.1):
// flags > env (SBX_API_URL, SBX_TEAM, SBX_PROFILE; SBX_API_KEY in auth/token.ts)
// > the profile in config.json > /etc/sbx/config.json (only apiUrl).

import {
	type Config,
	DEFAULT_PROFILE,
	type Env,
	type Paths,
	type Profile,
	readConfig,
	systemApiUrl,
} from "./config.ts";

/** Options every command takes (registered on the program). */
export interface GlobalOptions {
	json?: boolean;
	human?: boolean;
	profile?: string;
	apiUrl?: string;
	team?: string;
	cacert?: string;
	credentialStore?: string;
}

export interface Resolved {
	config: Config;
	profileName: string;
	profile: Profile | undefined;
	/** Without a trailing slash; undefined when nothing sets it. */
	apiUrl: string | undefined;
	team: string | undefined;
}

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

export function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Same API: equal origin and path, ignoring trailing slashes. */
export function sameApi(a: string, b: string): boolean {
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		return (
			ua.origin === ub.origin &&
			trimSlash(ua.pathname) === trimSlash(ub.pathname)
		);
	} catch {
		return trimSlash(a) === trimSlash(b);
	}
}

export function resolveProfile(
	g: GlobalOptions,
	env: Env,
	paths: Paths,
): Resolved {
	const config = readConfig(paths);
	const profileName =
		nonEmpty(g.profile) ??
		nonEmpty(env.SBX_PROFILE) ??
		nonEmpty(config.current) ??
		DEFAULT_PROFILE;
	const profile = config.profiles[profileName];
	const apiUrl =
		nonEmpty(g.apiUrl) ??
		nonEmpty(env.SBX_API_URL) ??
		profile?.apiUrl ??
		systemApiUrl(paths);
	const team = nonEmpty(g.team) ?? nonEmpty(env.SBX_TEAM) ?? profile?.team;
	return {
		config,
		profileName,
		profile,
		apiUrl: apiUrl === undefined ? undefined : trimSlash(apiUrl),
		team,
	};
}
