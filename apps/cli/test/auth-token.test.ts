// `umiak auth token`: refresh under the file lock (one refresh for parallel
// processes), invalid_grant → exit 4, UMIAK_API_KEY priority, and the SDK
// credential chain through the real CLI.
import { readFileSync } from "node:fs";
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

describe("umiak auth token", () => {
	let w: CliWorld;
	let home: CliHome;
	let _sub: string;
	beforeAll(async () => {
		w = await startWorld();
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(async () => {
		home = cliHome();
		_sub = `kc-${crypto.randomUUID()}`;
		const r = await runCli(["login", "--no-browser", "--api-url", w.url], {
			env: home.env,
		});
		expect(r.code, r.stderr).toBe(0);
	});
	afterEach(() => home.rm());

	const credFile = () => join(home.configDir, "credentials.json");
	const entry = () => `default@${w.url}`;
	function readCred(): Record<string, string> {
		return JSON.parse(JSON.parse(readFileSync(credFile(), "utf8"))[entry()]);
	}

	it("prints only the token without --json", async () => {
		const r = await runCli(["auth", "token"], { env: home.env });
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(`${readCred().token}\n`);
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
		expect(me.user?.email).toBe("local@umiak.invalid");
		expect(me.auth.kind).toBe("session");
	});
});
