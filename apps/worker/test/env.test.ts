import { describe, expect, it } from "vitest";
import { EnvError, parseAdminEnv, parseWorkerEnv } from "../src/env.ts";

const BASE = {
	DATABASE_URL: "postgres://umiak:umiak@db:5432/umiak",
	PAYLOAD_SECRET: "payload-secret-0123456789abcdef",
	UMIAK_DATA_KEYS_FILE: "/etc/umiak/keys.json",
	UMIAK_SECRETS_DIR: "/etc/umiak/secrets",
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
			parseWorkerEnv({ UMIAK_HTTP_PORT: "abc" });
		} catch (e) {
			msg = (e as Error).message;
		}
		for (const name of [
			"DATABASE_URL",
			"PAYLOAD_SECRET",
			"UMIAK_DATA_KEYS_FILE",
			"UMIAK_SECRETS_DIR",
			"UMIAK_HTTP_PORT",
		]) {
			expect(msg).toContain(name);
		}
	});

	it("PAYLOAD_SECRET is required; UMIAK_CONFIG_FILE is not (config comes from Payload)", () => {
		const { PAYLOAD_SECRET: _, ...rest } = BASE;
		expect(() => parseWorkerEnv(rest)).toThrow(/PAYLOAD_SECRET: required/);
		expect(() => parseWorkerEnv({ ...BASE, PAYLOAD_SECRET: "" })).toThrow(
			/PAYLOAD_SECRET: required/,
		);
		const env = parseWorkerEnv(BASE);
		expect(env).not.toHaveProperty("configFile");
		// A leftover UMIAK_CONFIG_FILE is ignored.
		expect(
			parseWorkerEnv({ ...BASE, UMIAK_CONFIG_FILE: "/etc/umiak/umiak.yaml" }),
		).toEqual(env);
	});

	it("defaults", () => {
		const env = parseWorkerEnv(BASE);
		expect(env).toMatchObject({
			databaseUrl: BASE.DATABASE_URL,
			payloadSecret: BASE.PAYLOAD_SECRET,
			dataKeysFile: BASE.UMIAK_DATA_KEYS_FILE,
			secretsDir: BASE.UMIAK_SECRETS_DIR,
			gatewayServiceTokenFile: undefined,
			reconcileDryRun: true,
			httpPort: 9090,
			migrateOnStart: true,
			logLevel: "info",
			dbPoolMax: 30,
			portDomain: undefined,
			sshUserCaKeysFile: undefined,
		});
	});

	it("port domain and SSH user CA keys file", () => {
		const env = parseWorkerEnv({
			...BASE,
			UMIAK_PORT_DOMAIN: "umiak.example.com",
			UMIAK_SSH_USER_CA_KEYS_FILE: "/etc/umiak/ssh-user-ca.pub",
		});
		expect(env.portDomain).toBe("umiak.example.com");
		expect(env.sshUserCaKeysFile).toBe("/etc/umiak/ssh-user-ca.pub");
		const empty = parseWorkerEnv({
			...BASE,
			UMIAK_PORT_DOMAIN: "",
			UMIAK_SSH_USER_CA_KEYS_FILE: "",
		});
		expect(empty.portDomain).toBeUndefined();
		expect(empty.sshUserCaKeysFile).toBeUndefined();
	});

	it("parses explicit values", () => {
		const env = parseWorkerEnv({
			...BASE,
			UMIAK_GATEWAY_SERVICE_TOKEN_FILE: "/run/secrets/gw",
			UMIAK_RECONCILE_DRY_RUN: "0",
			UMIAK_HTTP_PORT: "8080",
			UMIAK_MIGRATE_ON_START: "false",
			UMIAK_LOG_LEVEL: "debug",
			UMIAK_DB_POOL_MAX: "50",
		});
		expect(env).toMatchObject({
			gatewayServiceTokenFile: "/run/secrets/gw",
			reconcileDryRun: false,
			httpPort: 8080,
			migrateOnStart: false,
			logLevel: "debug",
			dbPoolMax: 50,
		});
	});

	it("rejects a bad boolean and log level", () => {
		expect(() =>
			parseWorkerEnv({ ...BASE, UMIAK_RECONCILE_DRY_RUN: "maybe" }),
		).toThrow(/UMIAK_RECONCILE_DRY_RUN/);
		expect(() => parseWorkerEnv({ ...BASE, UMIAK_LOG_LEVEL: "loud" })).toThrow(
			/UMIAK_LOG_LEVEL/,
		);
	});

	it("empty strings count as unset", () => {
		const env = parseWorkerEnv({ ...BASE, UMIAK_HTTP_PORT: "" });
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

	it("UMIAK_PVE_URL and UMIAK_PVE_TLS_NAME become the provider override", () => {
		expect(
			parseAdminEnv({ DATABASE_URL: BASE.DATABASE_URL }).providerOverride,
		).toEqual({});
		expect(
			parseAdminEnv({
				DATABASE_URL: BASE.DATABASE_URL,
				UMIAK_PVE_URL: "https://10.0.0.5:8006",
				UMIAK_PVE_TLS_NAME: "pve",
			}).providerOverride,
		).toEqual({ apiUrl: "https://10.0.0.5:8006", tlsName: "pve" });
		expect(() =>
			parseAdminEnv({ DATABASE_URL: BASE.DATABASE_URL, UMIAK_PVE_URL: "pve" }),
		).toThrow(/UMIAK_PVE_URL/);
	});
});
