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
			portDomain: undefined,
			sshUserCaKeysFile: undefined,
		});
	});

	it("port domain and SSH user CA keys file", () => {
		const env = parseWorkerEnv({
			...BASE,
			SBX_PORT_DOMAIN: "sbx.example.com",
			SBX_SSH_USER_CA_KEYS_FILE: "/etc/sbx/ssh-user-ca.pub",
		});
		expect(env.portDomain).toBe("sbx.example.com");
		expect(env.sshUserCaKeysFile).toBe("/etc/sbx/ssh-user-ca.pub");
		const empty = parseWorkerEnv({
			...BASE,
			SBX_PORT_DOMAIN: "",
			SBX_SSH_USER_CA_KEYS_FILE: "",
		});
		expect(empty.portDomain).toBeUndefined();
		expect(empty.sshUserCaKeysFile).toBeUndefined();
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

	it("SBX_PVE_URL and SBX_PVE_TLS_NAME become the provider override", () => {
		expect(
			parseAdminEnv({ DATABASE_URL: BASE.DATABASE_URL }).providerOverride,
		).toEqual({});
		expect(
			parseAdminEnv({
				DATABASE_URL: BASE.DATABASE_URL,
				SBX_PVE_URL: "https://10.0.0.5:8006",
				SBX_PVE_TLS_NAME: "pve",
			}).providerOverride,
		).toEqual({ apiUrl: "https://10.0.0.5:8006", tlsName: "pve" });
		expect(() =>
			parseAdminEnv({ DATABASE_URL: BASE.DATABASE_URL, SBX_PVE_URL: "pve" }),
		).toThrow(/SBX_PVE_URL/);
	});
});
