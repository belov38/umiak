import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSshCa } from "@umiak/auth";
import { describe, expect, it } from "vitest";
import {
	loadSettings,
	readHostKeys,
	readSshCa,
	SettingsError,
} from "../src/index.ts";
import { TEST_ENV } from "../src/testing/index.ts";

const CURSOR_KEY = Buffer.alloc(32, 1).toString("base64");

function errorOf(env: Record<string, string | undefined>): string {
	try {
		loadSettings(env);
	} catch (e) {
		expect(e).toBeInstanceOf(SettingsError);
		return (e as Error).message;
	}
	throw new Error("expected loadSettings to throw");
}

describe("loadSettings", () => {
	it("configures HTTP preview URLs with a custom port and validates their scheme", () => {
		expect(
			loadSettings({
				...TEST_ENV,
				UMIAK_PREVIEW_SCHEME: "http",
				UMIAK_PREVIEW_PORT: "8085",
			}),
		).toMatchObject({ previewScheme: "http", previewPort: 8085 });
		expect(
			loadSettings({ ...TEST_ENV, UMIAK_PREVIEW_SCHEME: "http" }),
		).toMatchObject({ previewScheme: "http", previewPort: 80 });
		expect(loadSettings(TEST_ENV)).toMatchObject({
			previewScheme: "https",
			previewPort: 443,
		});
		expect(errorOf({ ...TEST_ENV, UMIAK_PREVIEW_SCHEME: "ftp" })).toContain(
			"UMIAK_PREVIEW_SCHEME",
		);
		expect(errorOf({ ...TEST_ENV, UMIAK_PREVIEW_PORT: "65536" })).toContain(
			"UMIAK_PREVIEW_PORT",
		);
	});
	it("applies the defaults of the brief", () => {
		const s = loadSettings(TEST_ENV);
		expect(s).toMatchObject({
			publicPort: 8080,
			proxiedPort: 8081,
			internalPort: 8082,
			metricsPort: 9090,
			proxiedEnabled: true,
			sshHost: `ssh.${s.umiakDomain}`,
			sshPort: 22,
			sshHostKeysFile: null,
			sshLoginCaKeyFile: null,
			gatewayTokenFile: null,
			identityFile: null,
			operatorGroups: ["umiak-local-operator"],
			trustedProxyCidrs: [],
			rate: { rps: 20, burst: 100, startsPerMinute: 30 },
			maxStreams: 100,
			appOrigin: new URL(s.appUrl).origin,
			logLevel: "info",
		});
		expect(s.cursorKey.length).toBeGreaterThanOrEqual(32);
	});

	it("parses csv lists, ports, booleans and the owner settings", () => {
		const s = loadSettings({
			...TEST_ENV,
			UMIAK_API_PUBLIC_PORT: "18080",
			UMIAK_API_PROXIED_ENABLED: "false",
			UMIAK_API_TRUSTED_PROXY_CIDRS: "10.0.0.0/8,fd00::/8",
			UMIAK_SSH_HOST: "ssh.other.test",
			UMIAK_SSH_PORT: "2222",
		});
		expect(s.publicPort).toBe(18080);
		expect(s.proxiedEnabled).toBe(false);
		expect(s.operatorGroups).toEqual(["umiak-local-operator"]);
		expect(s.trustedProxyCidrs).toEqual(["10.0.0.0/8", "fd00::/8"]);

		expect(s.sshHost).toBe("ssh.other.test");
		expect(s.sshPort).toBe(2222);
	});

	it("empty strings count as unset", () => {
		const s = loadSettings({
			...TEST_ENV,
			UMIAK_SSH_PORT: "",
		});
		expect(s.sshPort).toBe(22);
	});

	it("lists every problem", () => {
		const msg = errorOf({
			...TEST_ENV,
			DATABASE_URL: undefined,
			UMIAK_API_CURSOR_KEY: Buffer.alloc(16).toString("base64"),
			UMIAK_API_PUBLIC_PORT: "x",
			UMIAK_API_TRUSTED_PROXY_CIDRS: "10.0.0.0/33",
			UMIAK_MIN_CLI_VERSION: "latest",
		});
		for (const k of [
			"DATABASE_URL",
			"UMIAK_API_CURSOR_KEY",
			"UMIAK_API_PUBLIC_PORT",
			"UMIAK_API_TRUSTED_PROXY_CIDRS",
			"UMIAK_MIN_CLI_VERSION",
		]) {
			expect(msg).toContain(k);
		}
	});

	it("does not require a CMS secret or configuration file", () => {
		const { PAYLOAD_SECRET: _, ...rest } = TEST_ENV;
		expect(loadSettings(rest)).not.toHaveProperty("payloadSecret");
	});

	it("rejects a cursor key that is not base64", () => {
		expect(
			errorOf({ ...TEST_ENV, UMIAK_API_CURSOR_KEY: `${CURSOR_KEY}!!` }),
		).toContain("UMIAK_API_CURSOR_KEY");
	});
});

describe("readHostKeys", () => {
	it("is empty without a file and reads public keys from the file", () => {
		expect(readHostKeys(null)).toEqual([]);
		const key = loadSshCa(
			generateKeyPairSync("ed25519").privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string,
		).publicKey;
		const dir = mkdtempSync(join(tmpdir(), "umiak-api-"));
		const file = join(dir, "host_keys");
		writeFileSync(file, `# gateway\n${key} root@gw\n`);
		expect(readHostKeys(file)).toEqual([key]);
	});
});

describe("readSshCa", () => {
	it("is null without a file, loads the CA from the file, refuses a non-ed25519 key", () => {
		expect(readSshCa(null)).toBeNull();
		const dir = mkdtempSync(join(tmpdir(), "umiak-api-"));
		const pem = generateKeyPairSync("ed25519").privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string;
		const file = join(dir, "login_ca");
		writeFileSync(file, pem);
		expect(readSshCa(file)?.publicKey).toBe(loadSshCa(pem).publicKey);
		const rsa = join(dir, "rsa");
		writeFileSync(
			rsa,
			generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
				format: "pem",
				type: "pkcs8",
			}) as string,
		);
		expect(() => readSshCa(rsa)).toThrow(/ed25519/);
		expect(() => readSshCa(join(dir, "missing"))).toThrow();
	});
});
