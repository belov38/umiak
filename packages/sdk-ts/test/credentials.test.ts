import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAuthCommand } from "../src/auth-command.ts";
import { createRawClient } from "../src/client.ts";
import { resolveCredentials } from "../src/credentials.ts";
import { type FakeUmiak, fakeUmiak } from "./fake-umiak.ts";

const API = "https://api.example.test";

let umiak: FakeUmiak;
beforeEach(async () => {
	umiak = await fakeUmiak();
});
afterEach(async () => {
	await umiak.cleanup();
});

function profile(over: Record<string, unknown> = {}) {
	return {
		kind: "key",
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
			apiKey: "umiak_explicit",
			env: { UMIAK_API_KEY: "umiak_env", UMIAK_ACCESS_TOKEN: "jwt-env" },
		});
		expect(await c.getToken()).toBe("umiak_explicit");
		expect(await c.getToken(true)).toBe("umiak_explicit");
	});

	it("accessToken and tokenProvider are explicit too", async () => {
		const a = await resolveCredentials({
			baseUrl: API,
			accessToken: "jwt-explicit",
			env: { UMIAK_API_KEY: "umiak_env" },
		});
		expect(await a.getToken()).toBe("jwt-explicit");

		let n = 0;
		const p = await resolveCredentials({
			baseUrl: API,
			tokenProvider: async () => `jwt-${++n}`,
			env: { UMIAK_API_KEY: "umiak_env" },
		});
		expect(await p.getToken()).toBe("jwt-1");
		expect(await p.getToken(true)).toBe("jwt-2");
	});

	it("UMIAK_API_KEY before UMIAK_ACCESS_TOKEN, both before umiak", async () => {
		await umiak.setOutput(profile());
		const k = await resolveCredentials({
			baseUrl: API,
			env: {
				...umiak.env,
				UMIAK_API_KEY: "umiak_env",
				UMIAK_ACCESS_TOKEN: "jwt-env",
			},
		});
		expect(await k.getToken()).toBe("umiak_env");
		const t = await resolveCredentials({
			baseUrl: API,
			env: { ...umiak.env, UMIAK_ACCESS_TOKEN: "jwt-env" },
		});
		expect(await t.getToken()).toBe("jwt-env");
		expect(await umiak.calls()).toEqual([]);
	});

	it("UMIAK_API_URL and UMIAK_TEAM fill baseUrl and team; options win", async () => {
		const env = {
			UMIAK_API_KEY: "umiak_env",
			UMIAK_API_URL: "https://env.example.test/",
			UMIAK_TEAM: "team_env",
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
			resolveCredentials({ apiKey: "umiak_x", env: {} }),
		).rejects.toMatchObject({ name: "UmiakError", code: "no_api_url" });
	});
});

describe("umiak auth token --json", () => {
	it("takes apiUrl, team and token from the profile and caches the token", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env });
		expect(c.baseUrl).toBe(API);
		expect(c.team).toBe("team_profile");
		expect(await c.getToken()).toBe("jwt-1");
		expect(await c.getToken()).toBe("jwt-1");
		expect(await umiak.calls()).toEqual(["auth token --json"]);
	});

	it("force re-runs the command", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env });
		await umiak.setOutput(profile({ token: "jwt-2" }));
		expect(await c.getToken(true)).toBe("jwt-2");
		expect(await c.getToken()).toBe("jwt-2");
		expect(await umiak.calls()).toHaveLength(2);
	});

	it("a token within 60 s of expiry is fetched again", async () => {
		await umiak.setOutput(
			profile({ expiresAt: new Date(Date.now() + 59_000).toISOString() }),
		);
		const c = await resolveCredentials({ env: umiak.env });
		await umiak.setOutput(profile({ token: "jwt-2" }));
		expect(await c.getToken()).toBe("jwt-2");
		expect(await umiak.calls()).toHaveLength(2);
	});

	it("a key profile (expiresAt null) is cached until forced", async () => {
		await umiak.setOutput(
			profile({ kind: "key", token: "umiak_profile", expiresAt: null }),
		);
		const c = await resolveCredentials({ env: umiak.env });
		expect(await c.getToken()).toBe("umiak_profile");
		expect(await c.getToken()).toBe("umiak_profile");
		expect(await umiak.calls()).toHaveLength(1);
	});

	it("concurrent getToken calls share one run", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env });
		await Promise.all([c.getToken(true), c.getToken(true), c.getToken(true)]);
		expect(await umiak.calls()).toHaveLength(2);
	});

	it("explicit team wins over the profile team", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env, team: "team_opt" });
		expect(c.team).toBe("team_opt");
	});

	it("a profile without a team leaves team unset", async () => {
		await umiak.setOutput(profile({ team: null }));
		const c = await resolveCredentials({ env: umiak.env });
		expect(c.team).toBeUndefined();
	});

	it("the same API with a trailing slash is accepted", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env, baseUrl: `${API}/` });
		expect(await c.getToken()).toBe("jwt-1");
	});

	it("does not use the token for another API", async () => {
		await umiak.setOutput(profile({ apiUrl: "https://other.example.test" }));
		await expect(
			resolveCredentials({ env: umiak.env, baseUrl: API }),
		).rejects.toMatchObject({ name: "UmiakError", code: "no_credentials" });
		await expect(
			resolveCredentials({
				env: { ...umiak.env, UMIAK_API_URL: API },
			}),
		).rejects.toMatchObject({ code: "no_credentials" });
	});

	it("the raw client sends nothing when the profile is for another API", async () => {
		await umiak.setOutput(profile({ apiUrl: "https://other.example.test" }));
		const seen: Request[] = [];
		const raw = createRawClient({
			env: umiak.env,
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
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env });
		await umiak.setOutput(
			profile({ token: "jwt-2", apiUrl: "https://other.example.test" }),
		);
		await expect(c.getToken(true)).rejects.toMatchObject({
			code: "no_credentials",
		});
	});

	it("no umiak in PATH: no credentials", async () => {
		await expect(
			resolveCredentials({ env: { PATH: "/nonexistent" } }),
		).rejects.toMatchObject({ name: "UmiakError", code: "no_credentials" });
	});

	it("umiak exits 4 (not logged in): no credentials", async () => {
		await umiak.setExit(4, "not logged in: run `umiak login`");
		await expect(resolveCredentials({ env: umiak.env })).rejects.toMatchObject({
			code: "no_credentials",
			message: expect.stringContaining("not logged in"),
		});
	});

	it("umiak printing garbage is an error, not a token", async () => {
		await writeFile(`${umiak.dir}/out.json`, "not json");
		await expect(resolveCredentials({ env: umiak.env })).rejects.toMatchObject({
			code: "auth_command_failed",
		});
	});

	it("an abort ends the wait for a slow umiak; the run goes on for others", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({ env: umiak.env });
		await umiak.setSleep(2);
		const ac = new AbortController();
		const aborted = c.getToken(true, ac.signal).catch((e: unknown) => e);
		let otherDone = false;
		const other = c.getToken(true).finally(() => {
			otherDone = true;
		});
		setTimeout(() => ac.abort(), 50);
		expect(await aborted).toMatchObject({ name: "AbortError" });
		// The abort did not wait for the run, which still goes on.
		expect(otherDone).toBe(false);
		expect(await other).toBe("jwt-1");
		expect(await umiak.calls()).toHaveLength(2);
	});

	it("an umiak that hangs past the timeout is killed (SIGKILL) and fails", async () => {
		await umiak.setOutput(profile());
		await umiak.setSleep(30, { ignoreTerm: true });
		const started = Date.now();
		const err = await runAuthCommand(
			["umiak", "auth", "token", "--json"],
			umiak.env,
			300,
		).catch((e: unknown) => e);
		expect(err).toMatchObject({
			code: "auth_command_failed",
			message: expect.stringContaining("timed out"),
		});
		// Killed, not waited for (30 s); room for a loaded machine.
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("authCommand replaces the default command", async () => {
		await umiak.setOutput(profile());
		const c = await resolveCredentials({
			env: umiak.env,
			authCommand: ["umiak", "--profile", "work", "auth", "token", "--json"],
		});
		expect(await c.getToken()).toBe("jwt-1");
		expect(await umiak.calls()).toEqual(["--profile work auth token --json"]);
	});
});
