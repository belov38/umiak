import type { Profile } from "../config.ts";
import { CliError, NOT_LOGGED_IN } from "../exit-codes.ts";
import type { CredentialStore } from "./store.ts";

export type StoredCredential = { kind: "key"; token: string };

export interface Bearer {
	kind: "key";
	token: string;
	/** ISO time; null for keys. */
	expiresAt: string | null;
}

/** Name of the credential entry: `<profile>@<apiUrl>`. */
export function credentialName(profileName: string, p: Profile): string {
	return `${profileName}@${p.apiUrl}`;
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
	return null;
}

export interface BearerDeps {
	profileName: string;
	/** The profile; undefined when there is none (only UMIAK_API_KEY can work). */
	profile: Profile | undefined;
	store: CredentialStore;
	env: Record<string, string | undefined>;
}

function notLoggedIn(profileName: string): CliError {
	return new CliError({
		code: NOT_LOGGED_IN,
		message: `profile ${JSON.stringify(profileName)} is not logged in; run: umiak login (or set UMIAK_API_KEY)`,
		retryable: false,
	});
}

/** The bearer to send now (see the header). */
export async function getBearer(d: BearerDeps): Promise<Bearer> {
	const envKey = d.env.UMIAK_API_KEY;
	if (envKey !== undefined && envKey !== "") {
		return { kind: "key", token: envKey, expiresAt: null };
	}
	if (d.profile === undefined) throw notLoggedIn(d.profileName);
	const name = credentialName(d.profileName, d.profile);
	const c = parseCredential(await d.store.get(name));
	if (c === null) throw notLoggedIn(d.profileName);
	return { kind: "key", token: c.token, expiresAt: null };
}
