// The bearer of a profile (S7 §7.6), shared by every command, `sbx auth
// token` (SDK, MCP) and later the in-process MCP module (S11 §6.1):
// - SBX_API_KEY in the env wins over the stored login;
// - a stored team key (`login --key-stdin`) is used as is;
// - a Keycloak access token is used until `exp − 90 s` (ruling R23: the SDK
//   treats a token as stale at `exp − 60 s`, so a token handed over must
//   have more left); then the refresh token is exchanged under the config
//   lock. A process that waited for the lock reads the credentials again
//   and uses the token the other one got. `invalid_grant` →
//   `login_required` (exit 4);
// - `force` (the api answered `401 token_expired` to `rejected`) refreshes
//   even a token that looks fresh, unless another process already stored a
//   different one.

import type { Profile } from "../config.ts";
import { CliError, NOT_LOGGED_IN } from "../exit-codes.ts";
import { deadline, type Fetch } from "../http.ts";
import { refreshTokens } from "./device-grant.ts";
import { withFileLock } from "./lock.ts";
import type { CredentialStore } from "./store.ts";

/** Keycloak client of the CLI (architecture §10). */
export const OIDC_CLIENT_ID = "sbx-cli";
/** An access token is refreshed this long before it expires (ruling R23). */
export const REFRESH_MARGIN_MS = 90_000;
/** Limit of one refresh request; below the stale age of the lock (30 s). */
export const REFRESH_TIMEOUT_MS = 20_000;

export type StoredCredential =
	| { kind: "key"; token: string }
	| {
			kind: "oidc";
			issuer: string;
			clientId: string;
			accessToken: string;
			refreshToken: string;
			/** ISO time. */
			expiresAt: string;
	  };

export interface Bearer {
	kind: "oidc" | "key";
	token: string;
	/** ISO time; null for keys. */
	expiresAt: string | null;
}

/** Name of the credential entry: `<profile>@<issuer|apiUrl>`. */
export function credentialName(profileName: string, p: Profile): string {
	return `${profileName}@${p.auth === "oidc" && p.issuer ? p.issuer : p.apiUrl}`;
}

export function parseCredential(v: string | null): StoredCredential | null {
	if (v === null) return null;
	let o: unknown;
	try {
		o = JSON.parse(v);
	} catch {
		return null;
	}
	const c = o as Record<string, unknown>;
	if (c?.kind === "key" && typeof c.token === "string") {
		return { kind: "key", token: c.token };
	}
	if (
		c?.kind === "oidc" &&
		typeof c.issuer === "string" &&
		typeof c.accessToken === "string" &&
		typeof c.refreshToken === "string" &&
		typeof c.expiresAt === "string"
	) {
		return {
			kind: "oidc",
			issuer: c.issuer,
			clientId: typeof c.clientId === "string" ? c.clientId : OIDC_CLIENT_ID,
			accessToken: c.accessToken,
			refreshToken: c.refreshToken,
			expiresAt: c.expiresAt,
		};
	}
	return null;
}

export interface BearerDeps {
	profileName: string;
	/** The profile; undefined when there is none (only SBX_API_KEY can work). */
	profile: Profile | undefined;
	store: CredentialStore;
	lockPath: string;
	fetch: Fetch;
	env: Record<string, string | undefined>;
	/** Refresh even a fresh-looking token: the api rejected it as expired. */
	force?: boolean;
	/** The token the api rejected (with `force`). */
	rejected?: string;
	/** Default REFRESH_TIMEOUT_MS. */
	refreshTimeoutMs?: number;
}

function notLoggedIn(profileName: string): CliError {
	return new CliError({
		code: NOT_LOGGED_IN,
		message: `profile ${JSON.stringify(profileName)} is not logged in; run: sbx login (or set SBX_API_KEY)`,
		retryable: false,
	});
}

function fresh(c: { expiresAt: string }): boolean {
	return Date.parse(c.expiresAt) - REFRESH_MARGIN_MS > Date.now();
}

/** The bearer to send now (see the header). */
export async function getBearer(d: BearerDeps): Promise<Bearer> {
	const envKey = d.env.SBX_API_KEY;
	if (envKey !== undefined && envKey !== "") {
		return { kind: "key", token: envKey, expiresAt: null };
	}
	if (d.profile === undefined) throw notLoggedIn(d.profileName);
	const name = credentialName(d.profileName, d.profile);
	const c = parseCredential(await d.store.get(name));
	if (c === null) throw notLoggedIn(d.profileName);
	if (c.kind === "key") return { kind: "key", token: c.token, expiresAt: null };
	const usable = (x: { accessToken: string; expiresAt: string }) =>
		fresh(x) &&
		!(d.force === true && (d.rejected ?? x.accessToken) === x.accessToken);
	if (usable(c)) return oidcBearer(c);
	return withFileLock(d.lockPath, async () => {
		// Another process may have refreshed while this one waited.
		const now = parseCredential(await d.store.get(name));
		if (now === null) throw notLoggedIn(d.profileName);
		if (now.kind === "key") {
			return { kind: "key" as const, token: now.token, expiresAt: null };
		}
		if (usable(now)) return oidcBearer(now);
		const limit = deadline(d.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS);
		let t: Awaited<ReturnType<typeof refreshTokens>>;
		try {
			t = await refreshTokens({
				issuer: now.issuer,
				clientId: now.clientId,
				refreshToken: now.refreshToken,
				fetch: d.fetch,
				signal: limit.signal,
			});
		} finally {
			limit.clear();
		}
		const next: StoredCredential = { ...now, ...t };
		await d.store.set(name, JSON.stringify(next));
		return oidcBearer(next);
	});
}

function oidcBearer(c: { accessToken: string; expiresAt: string }): Bearer {
	return { kind: "oidc", token: c.accessToken, expiresAt: c.expiresAt };
}
