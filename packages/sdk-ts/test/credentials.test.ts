import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAuthCommand } from "../src/auth-command.ts";
import { createRawClient } from "../src/client.ts";
import { resolveCredentials } from "../src/credentials.ts";
import { type FakeSbx, fakeSbx } from "./fake-sbx.ts";

const API = "https://api.example.test";

let sbx: FakeSbx;
beforeEach(async () => {
	sbx = await fakeSbx();
});
afterEach(async () => {
	await sbx.cleanup();
});

function profile(over: Record<string, unknown> = {}) {
	return {
		kind: "oidc",
		token: "jwt-1",
		expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		apiUrl: API,
		team: "team_profile",
		...over,
	};
}

describe("explicit and env credentials", () => {
	it("explicit apiKey wins over env", async () => {
		const c = await resolveCredentials({
			baseUrl: API,
			apiKey: "sbx_explicit",
			env: { SBX_API_KEY: "sbx_env", SBX_ACCESS_TOKEN: "jwt-env" },
		});
		expect(await c.getToken()).toBe("sbx_explicit");
		expect(await c.getToken(true)).toBe("sbx_explicit");
	});

	it("accessToken and tokenProvider are explicit too", async () => {
		const a = await resolveCredentials({
			baseUrl: API,
			accessToken: "jwt-explicit",
			env: { SBX_API_KEY: "sbx_env" },
		});
		expect(await a.getToken()).toBe("jwt-explicit");

		let n = 0;
		const p = await resolveCredentials({
			baseUrl: API,
			tokenProvider: async () => `jwt-${++n}`,
			env: { SBX_API_KEY: "sbx_env" },
		});
		expect(await p.getToken()).toBe("jwt-1");
		expect(await p.getToken(true)).toBe("jwt-2");
	});

	it("SBX_API_KEY before SBX_ACCESS_TOKEN, both before sbx", async () => {
		await sbx.setOutput(profile());
		const k = await resolveCredentials({
			baseUrl: API,
			env: { ...sbx.env, SBX_API_KEY: "sbx_env", SBX_ACCESS_TOKEN: "jwt-env" },
		});
		expect(await k.getToken()).toBe("sbx_env");
		const t = await resolveCredentials({
			baseUrl: API,
			env: { ...sbx.env, SBX_ACCESS_TOKEN: "jwt-env" },
		});
		expect(await t.getToken()).toBe("jwt-env");
		expect(await sbx.calls()).toEqual([]);
	});

	it("SBX_API_URL and SBX_TEAM fill baseUrl and team; options win", async () => {
		const env = {
			SBX_API_KEY: "sbx_env",
			SBX_API_URL: "https://env.example.test/",
			SBX_TEAM: "team_env",
		};
		const fromEnv = await resolveCredentials({ env });
		expect(fromEnv.baseUrl).toBe("https://env.example.test");
		expect(fromEnv.team).toBe("team_env");
		const explicit = await resolveCredentials({
			env,
			baseUrl: API,
			team: "team_opt",
		});
		expect(explicit.baseUrl).toBe(API);
		expect(explicit.team).toBe("team_opt");
	});

	it("a key without an API URL is a configuration error", async () => {
		await expect(
			resolveCredentials({ apiKey: "sbx_x", env: {} }),
		).rejects.toMatchObject({ name: "SbxError", code: "no_api_url" });
	});
});

describe("sbx auth token --json", () => {
	it("takes apiUrl, team and token from the profile and caches the token", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env });
		expect(c.baseUrl).toBe(API);
		expect(c.team).toBe("team_profile");
		expect(await c.getToken()).toBe("jwt-1");
		expect(await c.getToken()).toBe("jwt-1");
		expect(await sbx.calls()).toEqual(["auth token --json"]);
	});

	it("force re-runs the command", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env });
		await sbx.setOutput(profile({ token: "jwt-2" }));
		expect(await c.getToken(true)).toBe("jwt-2");
		expect(await c.getToken()).toBe("jwt-2");
		expect(await sbx.calls()).toHaveLength(2);
	});

	it("a token within 60 s of expiry is fetched again", async () => {
		await sbx.setOutput(
			profile({ expiresAt: new Date(Date.now() + 59_000).toISOString() }),
		);
		const c = await resolveCredentials({ env: sbx.env });
		await sbx.setOutput(profile({ token: "jwt-2" }));
		expect(await c.getToken()).toBe("jwt-2");
		expect(await sbx.calls()).toHaveLength(2);
	});

	it("a key profile (expiresAt null) is cached until forced", async () => {
		await sbx.setOutput(
			profile({ kind: "key", token: "sbx_profile", expiresAt: null }),
		);
		const c = await resolveCredentials({ env: sbx.env });
		expect(await c.getToken()).toBe("sbx_profile");
		expect(await c.getToken()).toBe("sbx_profile");
		expect(await sbx.calls()).toHaveLength(1);
	});

	it("concurrent getToken calls share one run", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env });
		await Promise.all([c.getToken(true), c.getToken(true), c.getToken(true)]);
		expect(await sbx.calls()).toHaveLength(2);
	});

	it("explicit team wins over the profile team", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env, team: "team_opt" });
		expect(c.team).toBe("team_opt");
	});

	it("a profile without a team leaves team unset", async () => {
		await sbx.setOutput(profile({ team: null }));
		const c = await resolveCredentials({ env: sbx.env });
		expect(c.team).toBeUndefined();
	});

	it("the same API with a trailing slash is accepted", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env, baseUrl: `${API}/` });
		expect(await c.getToken()).toBe("jwt-1");
	});

	it("does not use the token for another API", async () => {
		await sbx.setOutput(profile({ apiUrl: "https://other.example.test" }));
		await expect(
			resolveCredentials({ env: sbx.env, baseUrl: API }),
		).rejects.toMatchObject({ name: "SbxError", code: "no_credentials" });
		await expect(
			resolveCredentials({
				env: { ...sbx.env, SBX_API_URL: API },
			}),
		).rejects.toMatchObject({ code: "no_credentials" });
	});

	it("the raw client sends nothing when the profile is for another API", async () => {
		await sbx.setOutput(profile({ apiUrl: "https://other.example.test" }));
		const seen: Request[] = [];
		const raw = createRawClient({
			env: sbx.env,
			baseUrl: API,
			fetch: async (input) => {
				seen.push(input as Request);
				return new Response("{}");
			},
		});
		await expect(raw.GET("/v1/me")).rejects.toMatchObject({
			code: "no_credentials",
		});
		expect(seen).toEqual([]);
	});

	it("a refreshed token for another API is refused", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env });
		await sbx.setOutput(
			profile({ token: "jwt-2", apiUrl: "https://other.example.test" }),
		);
		await expect(c.getToken(true)).rejects.toMatchObject({
			code: "no_credentials",
		});
	});

	it("no sbx in PATH: no credentials", async () => {
		await expect(
			resolveCredentials({ env: { PATH: "/nonexistent" } }),
		).rejects.toMatchObject({ name: "SbxError", code: "no_credentials" });
	});

	it("sbx exits 4 (not logged in): no credentials", async () => {
		await sbx.setExit(4, "not logged in: run `sbx login`");
		await expect(resolveCredentials({ env: sbx.env })).rejects.toMatchObject({
			code: "no_credentials",
			message: expect.stringContaining("not logged in"),
		});
	});

	it("sbx printing garbage is an error, not a token", async () => {
		await writeFile(`${sbx.dir}/out.json`, "not json");
		await expect(resolveCredentials({ env: sbx.env })).rejects.toMatchObject({
			code: "auth_command_failed",
		});
	});

	it("an abort ends the wait for a slow sbx; the run goes on for others", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({ env: sbx.env });
		await sbx.setSleep(1);
		const ac = new AbortController();
		const started = Date.now();
		const aborted = c.getToken(true, ac.signal).catch((e: unknown) => e);
		const other = c.getToken(true);
		setTimeout(() => ac.abort(), 50);
		expect(await aborted).toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(800);
		expect(await other).toBe("jwt-1");
		expect(await sbx.calls()).toHaveLength(2);
	});

	it("an sbx that hangs past the timeout is killed (SIGKILL) and fails", async () => {
		await sbx.setOutput(profile());
		await sbx.setSleep(10, { ignoreTerm: true });
		const started = Date.now();
		const err = await runAuthCommand(
			["sbx", "auth", "token", "--json"],
			sbx.env,
			300,
		).catch((e: unknown) => e);
		expect(err).toMatchObject({
			code: "auth_command_failed",
			message: expect.stringContaining("timed out"),
		});
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it("authCommand replaces the default command", async () => {
		await sbx.setOutput(profile());
		const c = await resolveCredentials({
			env: sbx.env,
			authCommand: ["sbx", "--profile", "work", "auth", "token", "--json"],
		});
		expect(await c.getToken()).toBe("jwt-1");
		expect(await sbx.calls()).toEqual(["--profile work auth token --json"]);
	});
});
