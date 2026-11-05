// `umiak login` (owner pairing and --key-stdin), `umiak logout`, the credential
// store files, and --cacert / UMIAK_CA_FILE through a self-signed TLS front.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import type { SecretsBackend } from "../src/auth/keychain.ts";
import { browserCommand } from "../src/commands/login.ts";
import { runCli as runCliInProcess } from "../src/program.ts";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";
import { startTlsFront, type TlsFront } from "./helpers/tls.ts";

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
		const url = "https://umiak.example/auth/cli?code=AB&x=1";
		expect(browserCommand("win32", url)).toEqual([
			"rundll32",
			["url.dll,FileProtocolHandler", url],
		]);
		expect(browserCommand("darwin", url)).toEqual(["open", [url]]);
		expect(browserCommand("linux", url)).toEqual(["xdg-open", [url]]);
	});
});

describe("umiak login", () => {
	let w: CliWorld;
	let home: CliHome;
	beforeAll(async () => {
		w = await startWorld();
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(() => {
		home = cliHome();
	});
	afterEach(() => home.rm());

	it("--credential-store file keeps the tokens in credentials.json with mode 0600", async () => {
		const env = { ...home.env, UMIAK_CREDENTIAL_STORE: undefined };
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
		const entry = all[`work@${w.url}`];
		expect(entry).toBeTypeOf("string");
		const cred = JSON.parse(entry);
		expect(cred).toMatchObject({ kind: "key", token: expect.any(String) });
		const config = JSON.parse(
			readFileSync(join(home.configDir, "config.json"), "utf8"),
		);
		expect(config.current).toBe("work");
		expect(config.profiles.work.credentialStore).toBe("file");
		// The profile remembers its store: no flag or env needed later.
		const t = await runCli(["auth", "token"], { env });
		expect(t.code, t.stderr).toBe(0);
		expect(t.stdout.trim()).toBe(cred.token);
	});

	it("--key-stdin checks the key with /v1/me and stores it", async () => {
		const r = await runCli(["login", "--key-stdin", "--api-url", w.url], {
			env: home.env,
			stdin: `${w.secret}\n`,
		});
		expect(r.code, r.stderr).toBe(0);
		expect(r.last()).toMatchObject({
			event: "logged_in",
			me: { user: null, auth: { kind: "team_key" } },
		});
		const config = JSON.parse(
			readFileSync(join(home.configDir, "config.json"), "utf8"),
		);
		expect(config.profiles.default).toEqual({
			apiUrl: w.url,
			auth: "key",
			credentialStore: "file",
			tenancy: "single",
			tenancyCheckedAt: expect.any(Number),
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
		expect(who.code, who.stderr).toBe(0);
		const account = JSON.parse(who.stdout);
		expect(account).toMatchObject({
			user: null,
			auth: { kind: "team_key" },
		});
		expect(account).not.toHaveProperty("team");
	});

	it("--key-stdin with an unknown key exits 4 and stores nothing", async () => {
		const { generateApiKeySecret } = await import("@umiak/auth");
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

	it("--key-stdin checks the key locally: extra text or a bad key exits 2 before any request, without echoing it", async () => {
		const { generateApiKeySecret } = await import("@umiak/auth");
		const key = generateApiKeySecret();
		// Nothing listens there: a request would end with network_error (75).
		const nowhere = "http://127.0.0.1:1";
		const flipped = `${key.slice(0, -1)}${key.endsWith("A") ? "B" : "A"}`;
		for (const stdin of [
			`${key}\nsecond line\n`,
			`${key} trailing words\n`,
			flipped,
			"not-a-key",
			`Bearer ${key}`,
		]) {
			const r = await runCli(["login", "--key-stdin", "--api-url", nowhere], {
				env: home.env,
				stdin,
			});
			expect(r.code, `${JSON.stringify(stdin)}: ${r.stderr}`).toBe(2);
			expect(r.last()).toMatchObject({ event: "error", code: "usage" });
			expect(r.stdout).not.toContain(key.slice(4, 20));
			expect(r.stderr).not.toContain(key.slice(4, 20));
			expect(r.stdout).not.toContain("second line");
		}
		expect(() =>
			readFileSync(join(home.configDir, "credentials.json")),
		).toThrow();
		// Blank lines and CRLF around the key are fine.
		const ok = await runCli(["login", "--key-stdin", "--api-url", w.url], {
			env: home.env,
			stdin: `\r\n\n  ${w.secret}  \r\n\n`,
		});
		expect(ok.code, ok.stderr).toBe(0);
		expect(ok.last()).toMatchObject({ event: "logged_in" });
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

	it("re-login with another store deletes the secret from the old store", async () => {
		const secrets = fakeSecrets();
		const env = { ...home.env, UMIAK_CREDENTIAL_STORE: undefined };
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
		expect([...secrets.data.keys()]).toEqual([`umiak/default@${w.url}`]);
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

	it("an empty UMIAK_CREDENTIAL_STORE is treated as unset (auto)", async () => {
		const secrets = fakeSecrets();
		const r = await inProcess(["login", "--key-stdin", "--api-url", w.url], {
			env: { ...home.env, UMIAK_CREDENTIAL_STORE: "" },
			stdin: w.secret,
			secrets,
		});
		expect(r.code, r.stderr).toBe(0);
		expect([...secrets.data.keys()]).toEqual([`umiak/default@${w.url}`]);
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
			env: { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: key },
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
			env: { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: key },
		});
		expect(gone.code).toBe(4);
	});
});

describe("--cacert / UMIAK_CA_FILE (self-signed TLS front for api and owner)", () => {
	let tls: TlsFront;
	let w: CliWorld;
	let home: CliHome;
	beforeAll(async () => {
		tls = await startTlsFront();
		w = await startWorld();
		tls.route("/v1/", w.url);
	});
	afterAll(async () => {
		await w?.close();
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

	it("an unreadable --cacert is a usage error", async () => {
		const r = await runCli(
			["whoami", "--api-url", tls.url, "--cacert", "/nonexistent/ca.pem"],
			{
				env: { ...home.env, UMIAK_API_KEY: w.secret },
			},
		);
		expect(r.code).toBe(2);
		expect(r.last()).toMatchObject({ code: "usage" });
	});
});
