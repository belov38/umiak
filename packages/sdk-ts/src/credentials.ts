// Credential chain (S7 §7.6, §15.2):
//   explicit apiKey / accessToken / tokenProvider → SBX_API_KEY → SBX_ACCESS_TOKEN
//   → `sbx auth token --json` (Node and Bun only; the CLI owns refresh).
// Browsers have no `sbx`: they must pass apiKey, accessToken or tokenProvider.
// The API URL is `baseUrl`, then SBX_API_URL, then the apiUrl of the sbx profile;
// the team is `team`, then SBX_TEAM, then the team of the profile. A token from
// the sbx profile is never sent to another API than the profile's apiUrl.

import { canRunAuthCommand, runAuthCommand } from "./auth-command.ts";
import type { SbxOptions } from "./client.ts";
import {
	AUTH_COMMAND_FAILED,
	isAbortError,
	NO_API_URL,
	NO_CREDENTIALS,
	SbxError,
	TOKEN_PROVIDER_FAILED,
} from "./errors.ts";
import { abortable } from "./retry.ts";

export const DEFAULT_AUTH_COMMAND: readonly string[] = [
	"sbx",
	"auth",
	"token",
	"--json",
];
/** A token from `sbx auth token` is used until this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface Credentials {
	/** API URL without a trailing slash. */
	baseUrl: string;
	team?: string;
	/**
	 * The bearer to send; `force` skips the cache (after `401 token_expired`).
	 * `signal` ends the wait; a running `sbx` keeps going for other callers.
	 */
	getToken(force?: boolean, signal?: AbortSignal): Promise<string>;
}

/** Output of `sbx auth token --json`. */
export interface AuthToken {
	kind: string;
	token: string;
	expiresAt: string | null;
	apiUrl: string;
	team: string | null;
}

type Env = Record<string, string | undefined>;

export function defaultEnv(): Env {
	const proc = (globalThis as { process?: { env?: Env } }).process;
	return proc?.env ?? {};
}

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

function trimSlash(url: string): string {
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

const NO_CREDENTIALS_HINT =
	"pass apiKey, accessToken or tokenProvider, set SBX_API_KEY or SBX_ACCESS_TOKEN, or run `sbx login`";

function noCredentials(why: string): SbxError {
	return new SbxError({
		status: 0,
		code: NO_CREDENTIALS,
		message: `no credentials: ${why}; ${NO_CREDENTIALS_HINT}`,
		retryable: false,
	});
}

export async function resolveCredentials(
	opts: SbxOptions = {},
): Promise<Credentials> {
	const env = opts.env ?? defaultEnv();
	const url = nonEmpty(opts.baseUrl) ?? nonEmpty(env.SBX_API_URL);
	const team = nonEmpty(opts.team) ?? nonEmpty(env.SBX_TEAM);

	const provider = tokenSource(opts, env);
	if (provider) {
		if (url === undefined) {
			throw new SbxError({
				status: 0,
				code: NO_API_URL,
				message: "no API URL: pass baseUrl or set SBX_API_URL",
				retryable: false,
			});
		}
		return withTeam(
			{
				baseUrl: trimSlash(url),
				getToken: (force = false, signal) => abortable(provider(force), signal),
			},
			team,
		);
	}
	return fromAuthCommand(opts, env, url, team);
}

/** Explicit options first, then SBX_API_KEY, then SBX_ACCESS_TOKEN. */
function tokenSource(
	opts: SbxOptions,
	env: Env,
): ((force: boolean) => Promise<string>) | undefined {
	const explicit = nonEmpty(opts.apiKey) ?? nonEmpty(opts.accessToken);
	if (explicit !== undefined) return async () => explicit;
	const tokenProvider = opts.tokenProvider;
	if (tokenProvider) {
		return (force) => callTokenProvider(() => tokenProvider({ force }));
	}
	const fromEnv = nonEmpty(env.SBX_API_KEY) ?? nonEmpty(env.SBX_ACCESS_TOKEN);
	if (fromEnv !== undefined) return async () => fromEnv;
	return undefined;
}

/**
 * Calls the caller's tokenProvider. A rejection that is not an SbxError or an
 * abort becomes `token_provider_failed` (not retryable): the transport must
 * not repeat a request because a token source failed.
 */
async function callTokenProvider(
	provider: () => Promise<string>,
): Promise<string> {
	let token: unknown;
	try {
		token = await provider();
	} catch (err) {
		if (err instanceof SbxError || isAbortError(err)) throw err;
		const why = err instanceof Error ? err.message : String(err);
		throw new SbxError({
			status: 0,
			code: TOKEN_PROVIDER_FAILED,
			message: `tokenProvider failed: ${why}`,
			retryable: false,
			cause: err,
		});
	}
	if (typeof token !== "string" || token === "") {
		throw new SbxError({
			status: 0,
			code: TOKEN_PROVIDER_FAILED,
			message: "tokenProvider returned no token",
			retryable: false,
		});
	}
	return token;
}

function withTeam(c: Credentials, team: string | undefined): Credentials {
	return team === undefined ? c : { ...c, team };
}

async function fromAuthCommand(
	opts: SbxOptions,
	env: Env,
	url: string | undefined,
	team: string | undefined,
): Promise<Credentials> {
	if (!canRunAuthCommand()) {
		throw noCredentials(
			"no explicit credentials, and this runtime cannot run `sbx`",
		);
	}
	const cmd = opts.authCommand ?? DEFAULT_AUTH_COMMAND;
	const run = async (): Promise<AuthToken> =>
		parseAuthToken(await runAuthCommand(cmd, env));

	let current = await run();
	if (url !== undefined && !sameApi(url, current.apiUrl)) {
		throw noCredentials(`the sbx profile is for ${current.apiUrl}, not ${url}`);
	}
	const baseUrl = trimSlash(url ?? current.apiUrl);
	let inflight: Promise<AuthToken> | undefined;
	const refresh = async (): Promise<AuthToken> => {
		const next = await run();
		if (!sameApi(baseUrl, next.apiUrl)) {
			throw noCredentials(
				`the sbx profile is now for ${next.apiUrl}, not ${baseUrl}`,
			);
		}
		current = next;
		return next;
	};
	const fresh = (t: AuthToken) =>
		t.expiresAt === null ||
		Date.parse(t.expiresAt) - EXPIRY_MARGIN_MS > Date.now();

	return withTeam(
		{
			baseUrl,
			async getToken(force = false, signal) {
				if (!force && fresh(current)) return current.token;
				inflight ??= refresh().finally(() => {
					inflight = undefined;
				});
				return (await abortable(inflight, signal)).token;
			},
		},
		team ?? current.team ?? undefined,
	);
}

/** Validates the JSON printed by `sbx auth token --json`. */
export function parseAuthToken(stdout: string): AuthToken {
	let v: unknown;
	try {
		v = JSON.parse(stdout);
	} catch {
		v = undefined;
	}
	const o = (typeof v === "object" && v !== null ? v : {}) as Record<
		string,
		unknown
	>;
	const ok =
		typeof o.kind === "string" &&
		typeof o.token === "string" &&
		o.token !== "" &&
		typeof o.apiUrl === "string" &&
		(o.expiresAt === null || typeof o.expiresAt === "string") &&
		(o.team === undefined || o.team === null || typeof o.team === "string");
	if (!ok) {
		throw new SbxError({
			status: 0,
			code: AUTH_COMMAND_FAILED,
			message:
				"`sbx auth token --json` printed no {kind, token, expiresAt, apiUrl, team}",
			retryable: false,
		});
	}
	return {
		kind: o.kind as string,
		token: o.token as string,
		expiresAt: o.expiresAt as string | null,
		apiUrl: o.apiUrl as string,
		team: (o.team as string | null | undefined) ?? null,
	};
}
