// What a command gets: output, env, files, the resolved profile, the
// credential store, the bearer and an SDK client, each made on first use.

import { Umiak } from "@umiak/sdk";
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
import { caFetch, caWebSocket, type Fetch } from "./http.ts";
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
 * UMIAK_RETRY_BUDGET_MS overrides it.
 */
export const INTERACTIVE_RETRY_BUDGET_MS = 15_000;

/**
 * Retry budget of a file transfer (cp, push): a whole archive is repeated
 * within it, so it is longer. UMIAK_RETRY_BUDGET_MS overrides it too.
 */
export const TRANSFER_RETRY_BUDGET_MS = 120_000;

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
	#umiak: Umiak | undefined;
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

	/** fetch with the CA of --cacert / UMIAK_CA_FILE; every HTTPS call uses it. */
	get fetch(): Fetch {
		this.#fetch ??= caFetch(this.globals.cacert ?? this.env.UMIAK_CA_FILE);
		return this.#fetch;
	}

	get resolved(): Resolved {
		this.#resolved ??= resolveProfile(this.globals, this.env, this.paths);
		return this.#resolved;
	}

	/** Re-read config.json (after a command changed it). */
	reload(): void {
		this.#resolved = undefined;
		this.#umiak = undefined;
		this.#bearer = undefined;
	}

	/** See INTERACTIVE_RETRY_BUDGET_MS. */
	get retryBudgetMs(): number {
		return this.#budgetOverride() ?? INTERACTIVE_RETRY_BUDGET_MS;
	}

	/** See TRANSFER_RETRY_BUDGET_MS. */
	get transferBudgetMs(): number {
		return this.#budgetOverride() ?? TRANSFER_RETRY_BUDGET_MS;
	}

	#budgetOverride(): number | undefined {
		const v = Number(this.env.UMIAK_RETRY_BUDGET_MS);
		return Number.isInteger(v) &&
			v >= 0 &&
			this.env.UMIAK_RETRY_BUDGET_MS !== ""
			? v
			: undefined;
	}

	/** The API URL or CliError `no_api_url` (exit 4). */
	apiUrl(): string {
		const url = this.resolved.apiUrl;
		if (url === undefined) {
			throw new CliError({
				code: "no_api_url",
				message:
					"no API URL: run umiak login --api-url <url>, or set UMIAK_API_URL",
				retryable: false,
			});
		}
		return url;
	}

	/**
	 * The credential store: --credential-store, UMIAK_CREDENTIAL_STORE, the store
	 * the profile was logged in with, else auto.
	 */
	store(profile: Profile | undefined = this.resolved.profile): CredentialStore {
		return this.#open(
			nonEmpty(this.globals.credentialStore) ??
				nonEmpty(this.env.UMIAK_CREDENTIAL_STORE) ??
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
		const envKey = this.env.UMIAK_API_KEY;
		const apiUrl = this.apiUrl();
		if (
			(envKey === undefined || envKey === "") &&
			r.profile !== undefined &&
			!sameApi(apiUrl, r.profile.apiUrl)
		) {
			throw new CliError({
				code: NOT_LOGGED_IN,
				message: `profile ${JSON.stringify(r.profileName)} is logged in to ${r.profile.apiUrl}, not ${apiUrl}; run: umiak login --api-url ${apiUrl}`,
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
	umiak(): Umiak {
		if (this.#umiak !== undefined) return this.#umiak;
		const team = this.resolved.team;
		const webSocket = caWebSocket(
			this.globals.cacert ?? this.env.UMIAK_CA_FILE,
		);
		this.#umiak = new Umiak({
			...(webSocket === undefined ? {} : { webSocket }),
			baseUrl: this.apiUrl(),
			...(team === undefined ? {} : { team }),
			...(this.resolved.profile?.auth === "none" && !this.env.UMIAK_API_KEY
				? { session: true }
				: {
						tokenProvider: async ({ force }: { force: boolean }) =>
							(await this.bearer(force)).token,
					}),
			fetch: this.fetch as typeof fetch,
			userAgent: `umiak-cli/${CLI_VERSION}`,
			retryBudgetMs: this.retryBudgetMs,
			// Everything is resolved here; the SDK must not read UMIAK_* itself.
			env: {},
		});
		return this.#umiak;
	}
}
