// Test helpers of the api, exported as `@sbx/api/testing` (also used by the
// SDK and CLI tests that run the api in process).
import type { Logger } from "pino";
import type { ApiDeps } from "../deps.ts";
import { createApiLogger } from "../http/logger.ts";
import { ApiMetrics } from "../http/metrics.ts";
import { loadSettings, type Settings } from "../settings.ts";

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
 * database, no host keys. `over` replaces any field.
 */
export function makeTestDeps(over: Partial<ApiDeps> = {}): ApiDeps {
	return {
		settings: testSettings(),
		log: createApiLogger({ level: "silent" }),
		metrics: new ApiMetrics(),
		pool: null,
		hostKeys: [],
		...over,
	};
}
