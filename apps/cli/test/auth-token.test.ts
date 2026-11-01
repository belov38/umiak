// `umiak auth token`: refresh under the file lock (one refresh for parallel
// processes), invalid_grant → exit 4, UMIAK_API_KEY priority, and the SDK
// credential chain through the real CLI.
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Umiak } from "@umiak/sdk";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

const MAIN = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"main.ts",
);

function jwtClaims(token: string): Record<string, unknown> {
	return JSON.parse(
		Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
	);
}

describe("umiak auth token", () => {
	let w: CliWorld;
	let home: CliHome;
	let sub: string;
	beforeAll(async () => {
		w = await startWorld({ oidc: { deviceInterval: 0 } });
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(async () => {
		home = cliHome();
		sub = `kc-${crypto.randomUUID()}`;
		w.oidc.deviceFlow.autoApprove({ sub, email: `${sub}@example.com` });
		const r = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		expect(r.code, r.stderr).toBe(0);
	});
	afterEach(() => home.rm());

	const credFile = () => join(home.configDir, "credentials.json");
	const entry = () => `default@${w.oidc.issuer}`;
	function readCred(): Record<string, string> {
		return JSON.parse(JSON.parse(readFileSync(credFile(), "utf8"))[entry()]);
	}
	/** Moves the stored access token's expiry to the past (the refresh token stays valid). */
	function expireAccessToken(): string {
		const all = JSON.parse(readFileSync(credFile(), "utf8"));
		const cred = JSON.parse(all[entry()]);
		cred.expiresAt = new Date(Date.now() - 1000).toISOString();
		all[entry()] = JSON.stringify(cred);
		writeFileSync(credFile(), JSON.stringify(all), { mode: 0o600 });
		return cred.accessToken;
	}

	it("prints only the token without --json", async () => {
		const r = await runCli(["auth", "token"], { env: home.env });
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(`${readCred().accessToken}\n`);
	});

	it("a fresh access token is used without a refresh", async () => {
		const refreshes = w.oidc.stats.refresh;
		const r = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(JSON.parse(r.stdout).token).toBe(readCred().accessToken);
		expect(w.oidc.stats.refresh).toBe(refreshes);
	});

	it("two parallel processes with an expired access token make exactly one refresh", async () => {
		const old = expireAccessToken();
		const refreshes = w.oidc.stats.refresh;
		const [a, b] = await Promise.all([
			runCli(["auth", "token", "--json"], { env: home.env }),
			runCli(["auth", "token", "--json"], { env: home.env }),
		]);
		expect(a.code, a.stderr).toBe(0);
		expect(b.code, b.stderr).toBe(0);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
		const ta = JSON.parse(a.stdout);
		const tb = JSON.parse(b.stdout);
		expect(ta.token).toBe(tb.token);
		expect(ta.token).not.toBe(old);
		expect(jwtClaims(ta.token).sub).toBe(sub);
		expect(Date.parse(ta.expiresAt)).toBeGreaterThan(Date.now() + 200_000);
		// The new tokens are stored; the next process uses them as they are.
		expect(readCred().accessToken).toBe(ta.token);
		expect(readCred().refreshToken).toBeTypeOf("string");
		const c = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(JSON.parse(c.stdout).token).toBe(ta.token);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
	});

	it("an access token is refreshed 90 s before it expires", async () => {
		const all = JSON.parse(readFileSync(credFile(), "utf8"));
		const cred = JSON.parse(all[entry()]);
		cred.expiresAt = new Date(Date.now() + 60_000).toISOString();
		all[entry()] = JSON.stringify(cred);
		writeFileSync(credFile(), JSON.stringify(all), { mode: 0o600 });
		const refreshes = w.oidc.stats.refresh;
		const r = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(r.code, r.stderr).toBe(0);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
		expect(JSON.parse(r.stdout).token).not.toBe(cred.accessToken);
	});

	it("401 token_expired on a token the CLI thinks fresh forces a real refresh", async () => {
		// The api sees an expired JWT; the stored expiry says it is fresh.
		const expired = await w.oidc.token(
			{ sub, email: `${sub}@example.com` },
			{ expiresIn: -600 },
		);
		const all = JSON.parse(readFileSync(credFile(), "utf8"));
		const cred = JSON.parse(all[entry()]);
		cred.accessToken = expired;
		cred.expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		all[entry()] = JSON.stringify(cred);
		writeFileSync(credFile(), JSON.stringify(all), { mode: 0o600 });
		const refreshes = w.oidc.stats.refresh;
		const r = await runCli(["whoami"], { env: home.env });
		expect(r.code, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout).user.email).toBe(`${sub}@example.com`);
		expect(w.oidc.stats.refresh).toBe(refreshes + 1);
		expect(readCred().accessToken).not.toBe(expired);
	});

	it("a stale lock left by a dead process is taken over", async () => {
		expireAccessToken();
		const lock = join(home.configDir, ".lock");
		writeFileSync(lock, "99999 dead\n");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		const r = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(r.code, r.stderr).toBe(0);
		expect(() => readFileSync(lock)).toThrow();
	});

	it("invalid_grant (session over, user disabled) exits 4 with: run umiak login", async () => {
		expireAccessToken();
		w.oidc.revokeRefreshTokens();
		const r = await runCli(["auth", "token", "--json"], { env: home.env });
		expect(r.code).toBe(4);
		expect(r.last()).toMatchObject({
			event: "error",
			code: "login_required",
			retryable: false,
			requestId: null,
		});
		expect(r.stderr).toContain("umiak login");
		const plain = await runCli(["auth", "token"], { env: home.env });
		expect(plain.code).toBe(4);
		expect(plain.stdout).toBe("");
		expect(plain.stderr).toContain("umiak login");
		const who = await runCli(["whoami"], { env: home.env });
		expect(who.code).toBe(4);
		expect(who.last()).toMatchObject({ code: "login_required" });
	});

	it("UMIAK_API_KEY in the env wins over the stored login", async () => {
		const r = await runCli(["auth", "token", "--json"], {
			env: { ...home.env, UMIAK_API_KEY: w.secret },
		});
		expect(JSON.parse(r.stdout)).toEqual({
			kind: "key",
			token: w.secret,
			expiresAt: null,
			apiUrl: w.url,
			team: null,
		});
		const who = await runCli(["whoami"], {
			env: { ...home.env, UMIAK_API_KEY: w.secret },
		});
		expect(JSON.parse(who.stdout).auth.kind).toBe("team_key");
	});

	it("a stored login is not used for another API URL", async () => {
		const r = await runCli(["auth", "token", "--json"], {
			env: { ...home.env, UMIAK_API_URL: "https://other.example.com" },
		});
		expect(r.code).toBe(4);
		expect(r.last()).toMatchObject({ code: "not_logged_in" });
	});

	it("without a login: exit 4", async () => {
		const other = cliHome();
		try {
			const r = await runCli(["auth", "token", "--json"], {
				env: { ...other.env, UMIAK_API_URL: w.url },
			});
			expect(r.code).toBe(4);
			expect(r.last()).toMatchObject({ event: "error", code: "not_logged_in" });
		} finally {
			other.rm();
		}
	});

	it("the SDK credential chain gets the same person through umiak auth token --json", async () => {
		const umiak = new Umiak({
			authCommand: [
				process.env.UMIAK_TEST_BUN ?? "bun",
				MAIN,
				"auth",
				"token",
				"--json",
			],
			env: home.env,
		});
		const me = await umiak.me();
		expect(me.user?.email).toBe(`${sub}@example.com`);
		expect(me.auth.kind).toBe("oidc");
	});
});
