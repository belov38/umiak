// Test helpers of the api, exported as `@umiak/api/testing` (also used by the
// SDK and CLI tests that run the api in process).
import { type EnvironmentStore, PgIdentityStore } from "@umiak/auth";
import { StaticConfigReader } from "@umiak/config";
import { RecordingJobSender, type SandboxService } from "@umiak/core";
import type { Logger } from "pino";
import { IdentityListener } from "../auth/identity-listener.ts";
import { ServiceTokens } from "../auth/internal.ts";
import { KeyCache } from "../auth/key-cache.ts";
import { SessionResolver } from "../auth/principal.ts";
import { RateLimits } from "../auth/rate-limit.ts";
import { DEFAULT_COMMAND_TIMINGS } from "../commands/attach.ts";
import { DEFAULT_PTY_TIMINGS } from "../commands/pty-socket.ts";
import { blockedSandboxesOf, StreamRegistry } from "../commands/registry.ts";
import type { ApiDeps } from "../deps.ts";
import { createApiLogger } from "../http/logger.ts";
import { ApiMetrics } from "../http/metrics.ts";
import { loadSettings, type Settings } from "../settings.ts";
import { ApiLifecycle } from "../shutdown.ts";
import { FakeAgent } from "./fake-agent.ts";
import {
	TEST_API_KEY,
	TEST_TEAM_ID,
	TEST_TEAM_NAME,
	testIdentityStore,
} from "./identity.ts";

export * from "./fake-agent.ts";
export * from "./identity.ts";

/** A complete valid environment with test values (no files are read). */
export const TEST_ENV: Readonly<Record<string, string>> = {
	UMIAK_AUTH_MODE: "owner",
	UMIAK_LOCAL_ALLOWED_CIDRS: "127.0.0.0/8,::1/128",
	DATABASE_URL: "postgres://umiak:umiak@127.0.0.1:5432/umiak",
	PAYLOAD_SECRET: "test-payload-secret-0123456789abcdef",
	UMIAK_DATA_KEYS_FILE: "/nonexistent/data-keys.json",
	UMIAK_API_CURSOR_KEY: Buffer.alloc(32, 7).toString("base64"),
	UMIAK_API_SERVICE_TOKENS_FILE: "/nonexistent/service-tokens.json",
	UMIAK_API_URL: "https://api.umiak.test",
	UMIAK_APP_URL: "https://app.umiak.test",
	UMIAK_PREVIEW_DOMAIN: "umiak.test",
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
 * A SandboxService for tests that need none: every method rejects. Tests
 * of the resource routes pass a real one (`apiWorld` in the api tests).
 */
export function unconfiguredService(): SandboxService {
	return new Proxy({} as SandboxService, {
		get(_t, name) {
			if (typeof name !== "string" || name === "then") return undefined;
			return () =>
				Promise.reject(
					new Error(`SandboxService.${name}: no service in these test deps`),
				);
		},
	});
}

/** An EnvironmentStore without environments; writes throw. */
export function emptyEnvironmentStore(): EnvironmentStore {
	const refuse = () =>
		Promise.reject(new Error("emptyEnvironmentStore: read only"));
	return {
		list: async () => [],
		get: async () => null,
		getDefault: async () => null,
		create: refuse,
		patch: refuse,
		delete: refuse,
	};
}

/**
 * Deps for tests: test settings, a silent logger, fresh metrics, no
 * database, no host keys, no SSH login CA. `over` replaces any field; the auth services are
 * built from the final settings, pool, identity and identityEvents:
 * - identity: PgIdentityStore over `pool` if given, else `testIdentityStore`
 *   that knows `TEST_API_KEY` (all scopes, team `TEST_TEAM_ID`);
 * - identityEvents: without a notifier (never emits, ready);
 * - serviceTokens: none accepted;
 * - svc: `unconfiguredService()`, jobs: a RecordingJobSender,
 *   config: an empty StaticConfigReader,
 *   environments: `emptyEnvironmentStore()`, agent: a FakeAgent;
 * - streams: a StreamRegistry over the final identity and identityEvents;
 *   commandTimings: the defaults (60 s, 15 s, 60 min); ptyTimings: the
 *   defaults (ping 15 s, input 5 ms, 1 MiB);
 * - lifecycle: running (not shutting down);
 * - configurationReady: null (no Payload: `/readyz` does not check it).
 */
export function makeTestDeps(over: Partial<ApiDeps> = {}): ApiDeps {
	const settings = over.settings ?? testSettings();
	const pool = over.pool ?? null;
	const identity =
		over.identity ??
		(pool === null
			? testIdentityStore({
					sessions: [
						{
							sub: "umiak:local",
							isOperator: true,
							teams: [
								{ teamId: TEST_TEAM_ID, name: TEST_TEAM_NAME, role: "owner" },
							],
						},
					],
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
	const log = over.log ?? createApiLogger({ level: "silent" });
	return {
		settings,
		log,
		metrics: new ApiMetrics(),
		pool,
		hostKeys: [],
		sshCa: null,
		identity,
		identityEvents,
		keyCache: new KeyCache(identity, identityEvents),
		sessions: new SessionResolver(identity, identityEvents),
		serviceTokens: new ServiceTokens({}),
		rateLimits: new RateLimits(settings.rate),
		svc: unconfiguredService(),
		jobs: new RecordingJobSender(),
		config: StaticConfigReader.fromObject({}),
		environments: emptyEnvironmentStore(),
		agent: new FakeAgent(),
		streams:
			over.streams ??
			new StreamRegistry({
				identity,
				events: identityEvents,
				maxPerPrincipal: settings.maxStreams,
				...(pool === null
					? {}
					: { blockedSandboxes: blockedSandboxesOf(pool) }),
				log,
			}),
		commandTimings: { ...DEFAULT_COMMAND_TIMINGS },
		ptyTimings: { ...DEFAULT_PTY_TIMINGS },
		lifecycle: new ApiLifecycle(),
		configurationReady: null,
		...over,
	};
}
