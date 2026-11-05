// `umiak keys` (S7 §13, §14.2): team keys; create and rotate only with a
// owner pairing of an owner.
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

describe("umiak keys", () => {
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

	it("a team key lists keys but cannot create one (exit 4, no API call needed)", async () => {
		const env = { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: w.secret };
		const list = await runCli(["keys", "list"], { env });
		expect(list.code, list.stderr).toBe(0);
		expect(JSON.parse(list.stdout).data.length).toBeGreaterThan(0);
		const c = await runCli(["keys", "create", "ci"], { env });
		expect(c.code).toBe(4);
		expect(c.last()).toMatchObject({
			event: "error",
			code: "user_required",
			requestId: null,
		});
		expect(c.stderr).toContain("umiak login");
	});

	it("an owner logged in with owner creates, lists, rotates and revokes a key", async () => {
		const _sub = `kc-${crypto.randomUUID()}`;
		const login = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		expect(login.code, login.stderr).toBe(0);
		const env = home.env;

		const c = await runCli(
			["keys", "create", "ci-main", "--preset", "ci", "--expires", "30d"],
			{ env },
		);
		expect(c.code, c.stderr).toBe(0);
		const created = JSON.parse(c.stdout);
		expect(created.secret).toMatch(/^umiak_/);
		expect(created.apiKey).toMatchObject({
			name: "ci-main",
			createdVia: "cli",
		});
		const days =
			(Date.parse(created.apiKey.expiresAt) - Date.now()) / 86_400_000;
		expect(Math.round(days)).toBe(30);
		// The new key works.
		const who = await runCli(["whoami"], {
			env: { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: created.secret },
		});
		expect(JSON.parse(who.stdout).auth.kind).toBe("team_key");

		const scoped = await runCli(
			[
				"keys",
				"create",
				"reader",
				"--scope",
				"sandboxes:read",
				"--scope",
				"commands:read",
			],
			{ env },
		);
		expect(scoped.code, scoped.stderr).toBe(0);
		expect(JSON.parse(scoped.stdout).apiKey.scopes).toEqual([
			"sandboxes:read",
			"commands:read",
		]);

		const human = await runCli(["keys", "list"], { env, tty: true });
		expect(human.stdout).toMatch(/ID\s+NAME/);
		expect(human.stdout).toContain("ci-main");

		const rot = await runCli(["keys", "rotate", created.apiKey.id], { env });
		expect(rot.code, rot.stderr).toBe(0);
		const rotated = JSON.parse(rot.stdout);
		expect(rotated.secret).not.toBe(created.secret);

		const rm = await runCli(["keys", "rm", created.apiKey.id], { env });
		expect(rm.code, rm.stderr).toBe(0);
		const list = JSON.parse((await runCli(["keys", "list"], { env })).stdout);
		const k = list.data.find((x: { id: string }) => x.id === created.apiKey.id);
		expect(k.revokedAt).not.toBeNull();
		const gone = await runCli(["whoami"], {
			env: { ...home.env, UMIAK_API_URL: w.url, UMIAK_API_KEY: rotated.secret },
		});
		expect(gone.code).toBe(4);

		const both = await runCli(
			["keys", "create", "x", "--preset", "ci", "--scope", "sandboxes:read"],
			{ env },
		);
		expect(both.code).toBe(2);
	});
});
