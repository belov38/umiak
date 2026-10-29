import { describe, expect, it } from "vitest";
import { EnvError, parseAdminEnv, parseWorkerEnv } from "../src/env.ts";

const BASE = {
	DATABASE_URL: "postgres://sbx:sbx@db:5432/sbx",
	SBX_CONFIG_FILE: "/etc/sbx/config.yaml",
	SBX_DATA_KEYS_FILE: "/etc/sbx/keys.json",
	SBX_SECRETS_DIR: "/etc/sbx/secrets",
};

describe("worker env", () => {
	it("missing DATABASE_URL is a clear error", () => {
		const { DATABASE_URL: _, ...rest } = BASE;
		expect(() => parseWorkerEnv(rest)).toThrow(EnvError);
		expect(() => parseWorkerEnv(rest)).toThrow(/DATABASE_URL: required/);
	});

	it("a DATABASE_URL that is not a postgres URL is rejected", () => {
		expect(() =>
			parseWorkerEnv({ ...BASE, DATABASE_URL: "mysql://x@y/z" }),
		).toThrow(/DATABASE_URL: .*postgres/);
	});

	it("lists every problem at once", () => {
		let msg = "";
		try {
			parseWorkerEnv({ SBX_HTTP_PORT: "abc" });
		} catch (e) {
			msg = (e as Error).message;
		}
		for (const name of [
			"DATABASE_URL",
			"SBX_CONFIG_FILE",
			"SBX_DATA_KEYS_FILE",
			"SBX_SECRETS_DIR",
			"SBX_HTTP_PORT",
		]) {
			expect(msg).toContain(name);
		}
	});

	it("defaults", () => {
		const env = parseWorkerEnv(BASE);
		expect(env).toMatchObject({
			databaseUrl: BASE.DATABASE_URL,
			configFile: BASE.SBX_CONFIG_FILE,
			dataKeysFile: BASE.SBX_DATA_KEYS_FILE,
			secretsDir: BASE.SBX_SECRETS_DIR,
			gatewayServiceTokenFile: undefined,
			reconcileDryRun: true,
			httpPort: 9090,
			migrateOnStart: true,
			logLevel: "info",
			dbPoolMax: 30,
			idpSyncIntervalMs: 300_000,
		});
	});

	it("parses explicit values", () => {
		const env = parseWorkerEnv({
			...BASE,
			SBX_GATEWAY_SERVICE_TOKEN_FILE: "/run/secrets/gw",
			SBX_RECONCILE_DRY_RUN: "0",
			SBX_HTTP_PORT: "8080",
			SBX_MIGRATE_ON_START: "false",
			SBX_LOG_LEVEL: "debug",
			SBX_DB_POOL_MAX: "50",
			SBX_IDP_SYNC_INTERVAL: "60",
		});
		expect(env).toMatchObject({
			gatewayServiceTokenFile: "/run/secrets/gw",
			reconcileDryRun: false,
			httpPort: 8080,
			migrateOnStart: false,
			logLevel: "debug",
			dbPoolMax: 50,
			idpSyncIntervalMs: 60_000,
		});
	});

	it("rejects a bad boolean and log level", () => {
		expect(() =>
			parseWorkerEnv({ ...BASE, SBX_RECONCILE_DRY_RUN: "maybe" }),
		).toThrow(/SBX_RECONCILE_DRY_RUN/);
		expect(() => parseWorkerEnv({ ...BASE, SBX_LOG_LEVEL: "loud" })).toThrow(
			/SBX_LOG_LEVEL/,
		);
	});

	it("empty strings count as unset", () => {
		const env = parseWorkerEnv({ ...BASE, SBX_HTTP_PORT: "" });
		expect(env.httpPort).toBe(9090);
	});
});

describe("admin env", () => {
	it("needs only DATABASE_URL", () => {
		expect(parseAdminEnv({ DATABASE_URL: BASE.DATABASE_URL })).toMatchObject({
			databaseUrl: BASE.DATABASE_URL,
			configFile: undefined,
			secretsDir: undefined,
		});
		expect(() => parseAdminEnv({})).toThrow(/DATABASE_URL: required/);
	});
});
