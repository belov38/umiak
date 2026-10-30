// What a command gets: output, env, files, the resolved profile, the
// credential store, the bearer and an SDK client, each made on first use.

import { Sbx } from "@sbx/sdk";
import { bunSecrets, type SecretsBackend } from "./auth/keychain.ts";
import {
	type CredentialStore,
	openCredentialStore,
	parseStoreChoice,
} from "./auth/store.ts";
import { type Bearer, getBearer, REFRESH_MARGIN_MS } from "./auth/token.ts";
import { CLI_VERSION } from "./commands/version.ts";
import { type Env, type Paths, type Profile, pathsOf } from "./config.ts";
import { CliError, NOT_LOGGED_IN } from "./exit-codes.ts";
import { caFetch, type Fetch } from "./http.ts";
import type { Output } from "./output.ts";
import {
	type GlobalOptions,
	type Resolved,
	resolveProfile,
	sameApi,
} from "./profile.ts";

/**
 * Retry budget of one SDK call of a command (CallOptions.retryBudgetMs), so
 * a dead API ends an interactive command with exit 75 quickly. Waits
 * (`--wait`, exec streams once started) keep their own deadlines.
 * SBX_RETRY_BUDGET_MS overrides it.
 */
export const INTERACTIVE_RETRY_BUDGET_MS = 15_000;

export interface ContextOptions {
	out: Output;
	env: Env;
	globals: GlobalOptions;
	stdin: NodeJS.ReadableStream;
	/** Keychain backend; default Bun.secrets. */
	secrets?: SecretsBackend | undefined;
	/** stdin and stderr are a terminal: prompts can be answered. */
	interactive?: boolean;
	/** The whole command line (for the words after `--`). */
	argv?: readonly string[];
}

function nonEmpty(v: string | undefined): string | undefined {
	return v === undefined || v === "" ? undefined : v;
}

export class Context {
	readonly out: Output;
	readonly env: Env;
	readonly globals: GlobalOptions;
	readonly paths: Paths;
	readonly stdin: NodeJS.ReadableStream;
	readonly interactive: boolean;
	readonly argv: readonly string[];
	readonly #secrets: SecretsBackend | undefined;
	#fetch: Fetch | undefined;
	#resolved: Resolved | undefined;
	#sbx: Sbx | undefined;
	#bearer: Bearer | undefined;

	constructor(o: ContextOptions) {
		this.out = o.out;
		this.env = o.env;
		this.globals = o.globals;
		this.stdin = o.stdin;
		this.interactive = o.interactive === true;
		this.argv = o.argv ?? [];
		this.paths = pathsOf(o.env);
		this.#secrets = "secrets" in o ? o.secrets : bunSecrets();
	}

	/** fetch with the CA of --cacert / SBX_CA_FILE; every HTTPS call uses it. */
	get fetch(): Fetch {
		this.#fetch ??= caFetch(this.globals.cacert ?? this.env.SBX_CA_FILE);
		return this.#fetch;
	}

	get resolved(): Resolved {
		this.#resolved ??= resolveProfile(this.globals, this.env, this.paths);
		return this.#resolved;
	}

	/** Re-read config.json (after a command changed it). */
	reload(): void {
		this.#resolved = undefined;
		this.#sbx = undefined;
		this.#bearer = undefined;
	}

	/** See INTERACTIVE_RETRY_BUDGET_MS. */
	get retryBudgetMs(): number {
		const v = Number(this.env.SBX_RETRY_BUDGET_MS);
		return Number.isInteger(v) && v >= 0 && this.env.SBX_RETRY_BUDGET_MS !== ""
			? v
			: INTERACTIVE_RETRY_BUDGET_MS;
	}

	/** The API URL or CliError `no_api_url` (exit 4). */
	apiUrl(): string {
		const url = this.resolved.apiUrl;
		if (url === undefined) {
			throw new CliError({
				code: "no_api_url",
				message:
					"no API URL: run sbx login --api-url <url>, or set SBX_API_URL",
				retryable: false,
			});
		}
		return url;
	}

	/**
	 * The credential store: --credential-store, SBX_CREDENTIAL_STORE, the store
	 * the profile was logged in with, else auto.
	 */
	store(profile: Profile | undefined = this.resolved.profile): CredentialStore {
		return this.#open(
			nonEmpty(this.globals.credentialStore) ??
				nonEmpty(this.env.SBX_CREDENTIAL_STORE) ??
				profile?.credentialStore ??
				"auto",
		);
	}

	/** The store a profile was logged in with (flags and env do not apply). */
	storeOf(profile: Profile): CredentialStore {
		return this.#open(profile.credentialStore ?? "auto");
	}

	#open(choice: string): CredentialStore {
		return openCredentialStore(parseStoreChoice(choice), {
			file: this.paths.credentials,
			secrets: this.#secrets,
			warn: (m) => this.out.warn(m),
		});
	}

	/**
	 * The bearer of this command (auth/token.ts), refreshed when due.
	 * `force`: the api rejected the current one as expired.
	 */
	async bearer(force = false): Promise<Bearer> {
		const b = this.#bearer;
		if (
			!force &&
			b !== undefined &&
			(b.expiresAt === null ||
				Date.parse(b.expiresAt) - REFRESH_MARGIN_MS > Date.now())
		) {
			return b;
		}
		const r = this.resolved;
		const envKey = this.env.SBX_API_KEY;
		const apiUrl = this.apiUrl();
		if (
			(envKey === undefined || envKey === "") &&
			r.profile !== undefined &&
			!sameApi(apiUrl, r.profile.apiUrl)
		) {
			throw new CliError({
				code: NOT_LOGGED_IN,
				message: `profile ${JSON.stringify(r.profileName)} is logged in to ${r.profile.apiUrl}, not ${apiUrl}; run: sbx login --api-url ${apiUrl}`,
				retryable: false,
			});
		}
		this.#bearer = await getBearer({
			profileName: r.profileName,
			profile: r.profile,
			store: this.store(),
			lockPath: this.paths.lock,
			fetch: this.fetch,
			env: this.env,
			...(force ? { force, ...(b ? { rejected: b.token } : {}) } : {}),
		});
		return this.#bearer;
	}

	/** SDK client for the resolved API, team and bearer. */
	sbx(): Sbx {
		if (this.#sbx !== undefined) return this.#sbx;
		const team = this.resolved.team;
		this.#sbx = new Sbx({
			baseUrl: this.apiUrl(),
			...(team === undefined ? {} : { team }),
			tokenProvider: async ({ force }) => (await this.bearer(force)).token,
			fetch: this.fetch as typeof fetch,
			userAgent: `sbx-cli/${CLI_VERSION}`,
			retryBudgetMs: this.retryBudgetMs,
			// Everything is resolved here; the SDK must not read SBX_* itself.
			env: {},
		});
		return this.#sbx;
	}
}
