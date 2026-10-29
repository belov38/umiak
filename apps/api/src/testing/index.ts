// Test helpers of the api, exported as `@sbx/api/testing` (also used by the
// SDK and CLI tests that run the api in process).
import { PgIdentityStore } from "@sbx/auth";
import type { Logger } from "pino";
import { IdentityListener } from "../auth/identity-listener.ts";
import { ServiceTokens } from "../auth/internal.ts";
import { KeyCache } from "../auth/key-cache.ts";
import { OidcVerifier } from "../auth/oidc.ts";
import { SessionResolver } from "../auth/principal.ts";
import { RateLimits } from "../auth/rate-limit.ts";
import type { ApiDeps } from "../deps.ts";
import { createApiLogger } from "../http/logger.ts";
import { ApiMetrics } from "../http/metrics.ts";
import { loadSettings, type Settings } from "../settings.ts";
import {
	TEST_API_KEY,
	TEST_TEAM_ID,
	TEST_TEAM_NAME,
	testIdentityStore,
} from "./identity.ts";

export * from "./fake-agent.ts";
export * from "./identity.ts";
export * from "./oidc-server.ts";

/** A complete valid environment with test values (no files are read). */
export const TEST_ENV: Readonly<Record<string, string>> = {
	DATABASE_URL: "postgres://sbx:sbx@127.0.0.1:5432/sbx",
	SBX_CONFIG_FILE: "/nonexistent/config.yaml",
	SBX_DATA_KEYS_FILE: "/nonexistent/data-keys.json",
	SBX_API_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
	SBX_API_SERVICE_TOKENS_FILE: "/nonexistent/service-tokens.json",
	SBX_API_URL: "https://api.sbx.test",
	SBX_APP_URL: "https://app.sbx.test",
	SBX_SBX_DOMAIN: "sbx.test",
};

/** Settings from TEST_ENV with overrides (env variable names). */
export function testSettings(
	env: Record<string, string | undefined> = {},
): Settings {
	return loadSettings({ ...TEST_ENV, ...env });
}

export interface CapturedLogs {
	log: Logger;
	/** Parsed log lines so far. */
	entries(): Record<string, unknown>[];
	/** Raw text of all lines (for "secret never logged" checks). */
	text(): string;
}

/** A logger at `trace` that keeps its lines in memory (with redaction). */
export function captureLogs(): CapturedLogs {
	const lines: string[] = [];
	const log = createApiLogger(
		{ level: "trace" },
		{ write: (s: string) => void lines.push(s) },
	);
	return {
		log,
		entries: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
		text: () => lines.join(""),
	};
}

/**
 * Deps for tests: test settings, a silent logger, fresh metrics, no
 * database, no host keys. `over` replaces any field; the auth services are
 * built from the final settings, pool, identity and identityEvents:
 * - identity: PgIdentityStore over `pool` if given, else `testIdentityStore`
 *   that knows `TEST_API_KEY` (all scopes, team `TEST_TEAM_ID`);
 * - identityEvents: without a notifier (never emits, ready);
 * - oidc: a verifier when the settings have SBX_OIDC_ISSUER;
 * - serviceTokens: none accepted.
 */
export function makeTestDeps(over: Partial<ApiDeps> = {}): ApiDeps {
	const settings = over.settings ?? testSettings();
	const pool = over.pool ?? null;
	const identity =
		over.identity ??
		(pool === null
			? testIdentityStore({
					keys: [
						{
							secret: TEST_API_KEY,
							teamId: TEST_TEAM_ID,
							teamName: TEST_TEAM_NAME,
						},
					],
				})
			: new PgIdentityStore({ pool, operatorGroups: settings.operatorGroups }));
	const identityEvents = over.identityEvents ?? new IdentityListener(null);
	return {
		settings,
		log: createApiLogger({ level: "silent" }),
		metrics: new ApiMetrics(),
		pool,
		hostKeys: [],
		identity,
		identityEvents,
		keyCache: new KeyCache(identity, identityEvents),
		sessions: new SessionResolver(identity, identityEvents),
		oidc: settings.oidc === null ? null : new OidcVerifier(settings.oidc),
		serviceTokens: new ServiceTokens({}),
		rateLimits: new RateLimits(settings.rate),
		...over,
	};
}
