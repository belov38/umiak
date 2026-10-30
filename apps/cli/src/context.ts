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

export interface ContextOptions {
	out: Output;
	env: Env;
	globals: GlobalOptions;
	stdin: NodeJS.ReadableStream;
	/** Keychain backend; default Bun.secrets. */
	secrets?: SecretsBackend | undefined;
}

export class Context {
	readonly out: Output;
	readonly env: Env;
	readonly globals: GlobalOptions;
	readonly paths: Paths;
	readonly stdin: NodeJS.ReadableStream;
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
		const choice = parseStoreChoice(
			this.globals.credentialStore ??
				this.env.SBX_CREDENTIAL_STORE ??
				profile?.credentialStore ??
				"auto",
		);
		return openCredentialStore(choice, {
			file: this.paths.credentials,
			secrets: this.#secrets,
			warn: (m) => this.out.warn(m),
		});
	}

	/** The bearer of this command (auth/token.ts), refreshed when due. */
	async bearer(): Promise<Bearer> {
		const b = this.#bearer;
		if (
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
			tokenProvider: async () => (await this.bearer()).token,
			fetch: this.fetch as typeof fetch,
			userAgent: `sbx-cli/${CLI_VERSION}`,
			// Everything is resolved here; the SDK must not read SBX_* itself.
			env: {},
		});
		return this.#sbx;
	}
}
