// `sbx login` (device grant and --key-stdin), `sbx logout`, the credential
// store files, and --cacert / SBX_CA_FILE through a self-signed TLS front.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { startTestOidcServer, type TestOidcServer } from "@sbx/api/testing";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { deviceLogin } from "../src/auth/device-grant.ts";
import type { SecretsBackend } from "../src/auth/keychain.ts";
import { browserCommand } from "../src/commands/login.ts";
import { runCli as runCliInProcess } from "../src/program.ts";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";
import { startTlsFront, type TlsFront } from "./helpers/tls.ts";

function jwtClaims(token: string): Record<string, unknown> {
	const part = token.split(".")[1] ?? "";
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

const mode = (p: string) => statSync(p).mode & 0o777;

/** In-memory Bun.secrets. */
function fakeSecrets(): SecretsBackend & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		async get(o) {
			return data.get(`${o.service}/${o.name}`) ?? null;
		},
		async set(o) {
			data.set(`${o.service}/${o.name}`, o.value);
		},
		async delete(o) {
			return data.delete(`${o.service}/${o.name}`);
		},
	};
}

/** The CLI in this process (to pass a keychain stand-in). */
async function inProcess(
	argv: string[],
	o: {
		env: Record<string, string | undefined>;
		stdin?: string;
		secrets?: SecretsBackend;
	},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCliInProcess({
		argv,
		env: o.env,
		stdout: { write: (s: string | Uint8Array) => out.push(String(s)) },
		stderr: { write: (s: string | Uint8Array) => err.push(String(s)) },
		stdin: Readable.from([o.stdin ?? ""]),
		isTTY: false,
		secrets: o.secrets,
	});
	return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("openBrowser command", () => {
	it("Windows opens the link with rundll32 (no cmd parsing)", () => {
		const url = "https://kc.x/device?user_code=AB&x=1";
		expect(browserCommand("win32", url)).toEqual([
			"rundll32",
			["url.dll,FileProtocolHandler", url],
		]);
		expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
		expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
	});
});

describe("deviceLogin (unit, scripted Keycloak)", () => {
	it("polls at the interval, adds 5 s on slow_down, and returns the tokens", async () => {
		const answers: [number, Record<string, unknown>][] = [
			[
				200,
				{
					device_code: "dc",
					user_code: "ABCD-EFGH",
					verification_uri: "https://kc/device",
					expires_in: 600,
					interval: 5,
				},
			],
			[400, { error: "authorization_pending" }],
			[400, { error: "slow_down" }],
			[400, { error: "authorization_pending" }],
			[200, { access_token: "at", refresh_token: "rt", expires_in: 300 }],
		];
		const forms: Record<string, string>[] = [];
		const sleeps: number[] = [];
		const t = await deviceLogin({
			issuer: "https://kc/realms/sbx/",
			clientId: "sbx-cli",
			fetch: async (req) => {
				forms.push({
					url: req.url,
					...Object.fromEntries(new URLSearchParams(await req.text())),
				});
				const [status, body] = answers.shift() as [
					number,
					Record<string, unknown>,
				];
				return Response.json(body, { status });
			},
			onCode: () => {},
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
		expect(sleeps).toEqual([5000, 5000, 10_000, 10_000]);
		expect(forms[0]).toEqual({
			url: "https://kc/realms/sbx/protocol/openid-connect/auth/device",
			client_id: "sbx-cli",
			scope: "openid",
		});
		expect(forms[1]).toEqual({
			url: "https://kc/realms/sbx/protocol/openid-connect/token",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: "dc",
			client_id: "sbx-cli",
		});
	});
});

describe("sbx login", () => {
	let w: CliWorld;
	let home: CliHome;
	beforeAll(async () => {
		w = await startWorld({ oidc: { deviceInterval: 0 } });
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(() => {
		home = cliHome();
		w.oidc.deviceFlow.autoApprove(null);
	});
	afterEach(() => home.rm());

	it("device grant: login, then auth token gives a token of the same person", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		const email = `${sub}@example.com`;
		w.oidc.deviceFlow.autoApprove({ sub, email });
		const before = w.oidc.stats.deviceAuthorization;

		const r = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		expect(r.code, r.stderr).toBe(0);
		const lines = r.lines();
		expect(lines.map((l) => l.event)).toEqual(["device_code", "logged_in"]);
		expect(lines[0]).toMatchObject({
			userCode: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/),
			verificationUri: `${w.oidc.issuer}/device`,
		});
		expect(lines[1]).toMatchObject({
			profile: "default",
			apiUrl: w.url,
			me: { user: { email }, auth: { kind: "oidc" } },
		});
		expect(r.stderr).toContain("confirm the code");
		expect(r.stderr).toContain("credentials are stored in");
		expect(w.oidc.stats.deviceAuthorization).toBe(before + 1);

		const config = JSON.parse(
			readFileSync(join(home.configDir, "config.json"), "utf8"),
		);
		expect(config).toEqual({
			current: "default",
			profiles: {
				default: {
					apiUrl: w.url,
					auth: "oidc",
					issuer: w.oidc.issuer,
					credentialStore: "file",
				},
			},
		});
		const configText = readFileSync(
			join(home.configDir, "config.json"),
			"utf8",
		);
		expect(configText).not.toMatch(/eyJ/);
		expect(mode(join(home.configDir, "config.json"))).toBe(0o600);

		const t = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(t.code, t.stderr).toBe(0);
		const tok = JSON.parse(t.stdout);
		expect(tok).toMatchObject({ kind: "oidc", apiUrl: w.url, team: null });
		expect(Date.parse(tok.expiresAt)).toBeGreaterThan(Date.now() + 200_000);
		expect(jwtClaims(tok.token)).toMatchObject({ sub, email, azp: "sbx-cli" });

		const who = await runCli(["whoami"], { env: home.env });
		expect(who.code, who.stderr).toBe(0);
		expect(JSON.parse(who.stdout).user.email).toBe(email);
	});

	it("--credential-store file keeps the tokens in credentials.json with mode 0600", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		w.oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		const env = { ...home.env, SBX_CREDENTIAL_STORE: undefined };
		const r = await runCli(
			[
				"login",
				"--no-browser",
				"--api-url",
				w.url,
				"--credential-store",
				"file",
				"--profile",
				"work",
			],
			{ env },
		);
		expect(r.code, r.stderr).toBe(0);
		const file = join(home.configDir, "credentials.json");
		expect(mode(file)).toBe(0o600);
		const all = JSON.parse(readFileSync(file, "utf8"));
		const entry = all[`work@${w.oidc.issuer}`];
		expect(entry).toBeTypeOf("string");
		const cred = JSON.parse(entry);
		expect(cred).toMatchObject({
			kind: "oidc",
			issuer: w.oidc.issuer,
			clientId: "sbx-cli",
		});
		expect(cred.refreshToken).toBeTypeOf("string");
		const config = JSON.parse(
			readFileSync(join(home.configDir, "config.json"), "utf8"),
		);
		expect(config.current).toBe("work");
		expect(config.profiles.work.credentialStore).toBe("file");
		// The profile remembers its store: no flag or env needed later.
		const t = await runCli(["auth", "token"], { env });
		expect(t.code, t.stderr).toBe(0);
		expect(t.stdout.trim()).toBe(cred.accessToken);
	});

	it("waits through authorization_pending until the person confirms", async () => {
		const oidc = await startTestOidcServer({ deviceInterval: 1 });
		const w2 = await startWorld({ oidcServer: oidc });
		try {
			const sub = `kc-${crypto.randomUUID()}`;
			const run = runCli(["login", "--no-browser", "--api-url", w2.url], {
				env: home.env,
			});
			let code: string | undefined;
			for (let i = 0; i < 100 && code === undefined; i++) {
				await new Promise((r) => setTimeout(r, 50));
				code = oidc.deviceFlow.pending()[0];
			}
			expect(code).toBeDefined();
			await new Promise((r) => setTimeout(r, 1600));
			oidc.deviceFlow.approve(code as string, {
				sub,
				email: `${sub}@example.com`,
			});
			const r = await run;
			expect(r.code, r.stderr).toBe(0);
			expect(r.last()).toMatchObject({
				event: "logged_in",
				me: { user: { email: `${sub}@example.com` } },
			});
			expect(oidc.stats.token).toBeGreaterThanOrEqual(2);
		} finally {
			await w2.close();
			await oidc.close();
		}
	});

	it("an expired device code exits 4 and stores nothing", async () => {
		const oidc = await startTestOidcServer({
			deviceInterval: 1,
			deviceExpiresIn: 1,
		});
		const w2 = await startWorld({ oidcServer: oidc });
		try {
			const r = await runCli(["login", "--no-browser", "--api-url", w2.url], {
				env: home.env,
			});
			expect(r.code).toBe(4);
			expect(r.last()).toMatchObject({ event: "error", code: "login_failed" });
			expect(r.last().message).toMatch(/expired/);
			expect(() => readFileSync(join(home.configDir, "config.json"))).toThrow();
		} finally {
			await w2.close();
			await oidc.close();
		}
	});

	it("a login denied in the browser exits 4 and stores nothing", async () => {
		const run = runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		let code: string | undefined;
		for (let i = 0; i < 200 && code === undefined; i++) {
			await new Promise((r) => setTimeout(r, 20));
			code = w.oidc.deviceFlow.pending()[0];
		}
		expect(code).toBeDefined();
		w.oidc.deviceFlow.deny(code as string);
		const r = await run;
		expect(r.code).toBe(4);
		expect(r.last()).toMatchObject({
			code: "login_failed",
			message: expect.stringMatching(/denied/),
		});
		expect(() => readFileSync(join(home.configDir, "config.json"))).toThrow();
	});

	it("--key-stdin checks the key with /v1/me and stores it", async () => {
		const r = await runCli(["login", "--key-stdin", "--api-url", w.url], {
			env: home.env,
			stdin: `${w.secret}\n`,
		});
		expect(r.code, r.stderr).toBe(0);
		expect(r.last()).toMatchObject({
			event: "logged_in",
			me: { user: null, team: { id: w.teamId }, auth: { kind: "team_key" } },
		});
		const config = JSON.parse(
			readFileSync(join(home.configDir, "config.json"), "utf8"),
		);
		expect(config.profiles.default).toEqual({
			apiUrl: w.url,
			auth: "key",
			credentialStore: "file",
		});
		const t = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(JSON.parse(t.stdout)).toEqual({
			kind: "key",
			token: w.secret,
			expiresAt: null,
			apiUrl: w.url,
			team: null,
		});
		const who = await runCli(["whoami"], { env: home.env });
		expect(JSON.parse(who.stdout).team.id).toBe(w.teamId);
	});

	it("--key-stdin with an unknown key exits 4 and stores nothing", async () => {
		const { generateApiKeySecret } = await import("@sbx/auth");
		const r = await runCli(["login", "--key-stdin", "--api-url", w.url], {
			env: home.env,
			stdin: generateApiKeySecret(),
		});
		expect(r.code).toBe(4);
		expect(r.last()).toMatchObject({ event: "error", code: "unauthorized" });
		expect(() =>
			readFileSync(join(home.configDir, "credentials.json")),
		).toThrow();
		const e = await runCli(["login", "--key-stdin", "--api-url", w.url], {
			env: home.env,
			stdin: "",
		});
		expect(e.code).toBe(2);
	});

	it("--team is checked at login and kept in the profile", async () => {
		const r = await runCli(
			["login", "--key-stdin", "--api-url", w.url, "--team", w.teamId],
			{
				env: home.env,
				stdin: w.secret,
			},
		);
		expect(r.code, r.stderr).toBe(0);
		const t = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(JSON.parse(t.stdout).team).toBe(w.teamId);
		const bad = await runCli(
			[
				"login",
				"--key-stdin",
				"--api-url",
				w.url,
				"--team",
				"team_00000000000000000000000000",
			],
			{ env: home.env, stdin: w.secret },
		);
		expect(bad.code).toBe(4);
		expect(bad.last()).toMatchObject({ code: "team_forbidden" });
	});

	it("logout of a Keycloak login revokes the refresh token and erases it", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		w.oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		expect(
			(
				await runCli(["login", "--no-browser", "--api-url", w.url], {
					env: home.env,
				})
			).code,
		).toBe(0);
		const revokes = w.oidc.stats.revoke;
		const r = await runCli(["logout"], { env: home.env });
		expect(r.code, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			profile: "default",
			loggedOut: true,
			revoked: true,
		});
		expect(w.oidc.stats.revoke).toBe(revokes + 1);
		expect(
			JSON.parse(
				readFileSync(join(home.configDir, "credentials.json"), "utf8"),
			),
		).toEqual({});
		const t = await runCli(["auth", "token"], { env: home.env });
		expect(t.code).toBe(4);
		const again = await runCli(["logout"], { env: home.env });
		expect(JSON.parse(again.stdout)).toMatchObject({ loggedOut: false });
	});

	it("re-login into the same profile revokes the old refresh token", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		w.oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		const login = () =>
			runCli(["login", "--no-browser", "--api-url", w.url], { env: home.env });
		expect((await login()).code).toBe(0);
		const cred = () =>
			JSON.parse(
				JSON.parse(
					readFileSync(join(home.configDir, "credentials.json"), "utf8"),
				)[`default@${w.oidc.issuer}`],
			);
		const first = cred().refreshToken;
		const revokes = w.oidc.stats.revoke;
		const r = await login();
		expect(r.code, r.stderr).toBe(0);
		expect(w.oidc.stats.revoke).toBe(revokes + 1);
		expect(cred().refreshToken).not.toBe(first);
	});

	it("re-login with another store deletes the secret from the old store", async () => {
		const secrets = fakeSecrets();
		const env = { ...home.env, SBX_CREDENTIAL_STORE: undefined };
		const a = await inProcess(
			[
				"login",
				"--key-stdin",
				"--api-url",
				w.url,
				"--credential-store",
				"keychain",
			],
			{ env, stdin: w.secret, secrets },
		);
		expect(a.code, a.stderr).toBe(0);
		expect([...secrets.data.keys()]).toEqual([`sbx/default@${w.url}`]);
		const b = await inProcess(
			[
				"login",
				"--key-stdin",
				"--api-url",
				w.url,
				"--credential-store",
				"file",
			],
			{ env, stdin: w.secret, secrets },
		);
		expect(b.code, b.stderr).toBe(0);
		expect([...secrets.data.keys()]).toEqual([]);
		const file = JSON.parse(
			readFileSync(join(home.configDir, "credentials.json"), "utf8"),
		);
		expect(Object.keys(file)).toEqual([`default@${w.url}`]);
	});

	it("an empty SBX_CREDENTIAL_STORE is treated as unset (auto)", async () => {
		const secrets = fakeSecrets();
		const r = await inProcess(["login", "--key-stdin", "--api-url", w.url], {
			env: { ...home.env, SBX_CREDENTIAL_STORE: "" },
			stdin: w.secret,
			secrets,
		});
		expect(r.code, r.stderr).toBe(0);
		expect([...secrets.data.keys()]).toEqual([`sbx/default@${w.url}`]);
	});

	it("logout of a key only erases it; --revoke also revokes the key", async () => {
		const key = await w.key();
		const login = () =>
			runCli(["login", "--key-stdin", "--api-url", w.url], {
				env: home.env,
				stdin: key,
			});
		expect((await login()).code).toBe(0);
		const plain = await runCli(["logout"], { env: home.env });
		expect(JSON.parse(plain.stdout)).toEqual({
			profile: "default",
			loggedOut: true,
			revoked: false,
		});
		const still = await runCli(["whoami"], {
			env: { ...home.env, SBX_API_URL: w.url, SBX_API_KEY: key },
		});
		expect(still.code).toBe(0);

		expect((await login()).code).toBe(0);
		const rev = await runCli(["logout", "--revoke"], { env: home.env });
		expect(rev.code, rev.stderr).toBe(0);
		expect(JSON.parse(rev.stdout)).toEqual({
			profile: "default",
			loggedOut: true,
			revoked: true,
		});
		const gone = await runCli(["whoami"], {
			env: { ...home.env, SBX_API_URL: w.url, SBX_API_KEY: key },
		});
		expect(gone.code).toBe(4);
	});
});

describe("--cacert / SBX_CA_FILE (self-signed TLS front for api and Keycloak)", () => {
	let tls: TlsFront;
	let oidc: TestOidcServer;
	let w: CliWorld;
	let home: CliHome;
	beforeAll(async () => {
		tls = await startTlsFront();
		oidc = await startTestOidcServer({
			deviceInterval: 0,
			issuer: `${tls.url}/realms/sbx`,
		});
		w = await startWorld({
			oidcServer: oidc,
			settings: {
				SBX_OIDC_JWKS_URL: `${oidc.base}/realms/sbx/protocol/openid-connect/certs`,
			},
		});
		tls.route("/realms/", oidc.base);
		tls.route("/v1/", w.url);
	});
	afterAll(async () => {
		await w?.close();
		await oidc?.close();
		await tls?.close();
	});
	beforeEach(() => {
		home = cliHome();
	});
	afterEach(() => home.rm());

	it("without the CA the TLS front is refused (network_error, exit 75)", async () => {
		const r = await runCli(["login", "--no-browser", "--api-url", tls.url], {
			env: home.env,
		});
		expect(r.code).toBe(75);
		expect(r.last()).toMatchObject({
			event: "error",
			code: "network_error",
			retryable: true,
		});
		expect(r.last().message).toMatch(/certificate/i);
	});

	it("--cacert: device login through HTTPS api and Keycloak; SBX_CA_FILE for later commands", async () => {
		const sub = `kc-${crypto.randomUUID()}`;
		oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		const r = await runCli(
			["login", "--no-browser", "--api-url", tls.url, "--cacert", tls.caFile],
			{
				env: home.env,
			},
		);
		expect(r.code, r.stderr).toBe(0);
		expect(r.last()).toMatchObject({
			event: "logged_in",
			me: { user: { email: `${sub}@example.com` } },
		});
		expect(oidc.stats.deviceAuthorization).toBeGreaterThanOrEqual(1);

		const who = await runCli(["whoami"], {
			env: { ...home.env, SBX_CA_FILE: tls.caFile },
		});
		expect(who.code, who.stderr).toBe(0);
		expect(JSON.parse(who.stdout).user.email).toBe(`${sub}@example.com`);

		// A refresh goes to Keycloak through the same CA.
		const file = join(home.configDir, "credentials.json");
		const all = JSON.parse(readFileSync(file, "utf8"));
		const name = `default@${oidc.issuer}`;
		const cred = JSON.parse(all[name]);
		cred.expiresAt = new Date(Date.now() - 1000).toISOString();
		all[name] = JSON.stringify(cred);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
		const refreshes = oidc.stats.refresh;
		const t = await runCli(["auth", "token", "--json"], {
			env: { ...home.env, SBX_CA_FILE: tls.caFile },
		});
		expect(t.code, t.stderr).toBe(0);
		expect(oidc.stats.refresh).toBe(refreshes + 1);
	});

	it("an unreadable --cacert is a usage error", async () => {
		const r = await runCli(
			["whoami", "--api-url", tls.url, "--cacert", "/nonexistent/ca.pem"],
			{
				env: { ...home.env, SBX_API_KEY: w.secret },
			},
		);
		expect(r.code).toBe(2);
		expect(r.last()).toMatchObject({ code: "usage" });
	});
});
