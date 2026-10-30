// The output contract (S7 §14.3) and exit codes: unit tests of Output and
// exitCodeOf, then the real CLI against the api (whoami, errors, usage,
// current, version, completion, mcp).
import { SbxError } from "@sbx/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CliError,
	EXIT_NO_AUTH,
	EXIT_NOT_FOUND,
	EXIT_TEMPORARY,
	exitCodeOf,
} from "../src/exit-codes.ts";
import { Output, outputMode } from "../src/output.ts";
import { type CliWorld, startWorld } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		stdout: { write: (s: string) => void out.push(s) },
		stderr: { write: (s: string) => void err.push(s) },
	};
}

const apiErr = new SbxError({
	status: 401,
	code: "unauthorized",
	message: "bad key",
	retryable: false,
	details: { reason: "invalid_token" },
	requestId: "req_1",
});

describe("Output (unit)", () => {
	it("prints JSON when stdout is not a terminal, text in a terminal", () => {
		const a = capture();
		new Output({ ...a, isTTY: false }).result({ x: 1, y: { z: "a" } });
		expect(a.out.join("")).toBe('{"x":1,"y":{"z":"a"}}\n');
		const b = capture();
		new Output({ ...b, isTTY: true }).result({ x: 1, y: { z: "a" } });
		expect(b.out.join("")).toBe("x: 1\ny:\n  z: a\n");
	});

	it("--json wins in a terminal, --human wins in a pipe and over --json", () => {
		expect(
			new Output({ ...capture(), isTTY: true, explicitJson: true }).json,
		).toBe(true);
		expect(
			new Output({ ...capture(), isTTY: false, explicitHuman: true }).json,
		).toBe(false);
		expect(outputMode(["--json", "whoami"], {})).toEqual({
			explicitJson: true,
			explicitHuman: false,
		});
		expect(outputMode(["--json", "--human"], {})).toEqual({
			explicitJson: false,
			explicitHuman: true,
		});
		expect(outputMode(["whoami"], { SBX_OUTPUT: "json" })).toEqual({
			explicitJson: true,
			explicitHuman: false,
		});
		expect(outputMode(["--human"], { SBX_OUTPUT: "json" })).toEqual({
			explicitJson: false,
			explicitHuman: true,
		});
		// After `--` the words belong to the remote command.
		expect(outputMode(["exec", "sb", "--", "x", "--json"], {})).toEqual({
			explicitJson: false,
			explicitHuman: false,
		});
	});

	it("events are JSON Lines with `event`; the error is the last stdout line", () => {
		const a = capture();
		const o = new Output({ ...a, isTTY: false });
		o.event("accepted", { sandbox: { id: "sb_1" } });
		o.event("state", { state: "starting" });
		o.error(apiErr);
		const lines = a.out
			.join("")
			.trimEnd()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines).toEqual([
			{ event: "accepted", sandbox: { id: "sb_1" } },
			{ event: "state", state: "starting" },
			{
				event: "error",
				code: "unauthorized",
				message: "bad key",
				retryable: false,
				details: { reason: "invalid_token" },
				requestId: "req_1",
			},
		]);
		expect(a.err.join("")).toContain("bad key");
	});

	it("an error without an API answer has requestId null; human errors go to stderr only", () => {
		const a = capture();
		new Output({ ...a, isTTY: false }).error(new Error("oops"));
		expect(JSON.parse(a.out.join(""))).toEqual({
			event: "error",
			code: "internal",
			message: "oops",
			retryable: false,
			details: {},
			requestId: null,
		});
		const b = capture();
		new Output({ ...b, isTTY: true }).error(apiErr);
		expect(b.out).toEqual([]);
		expect(b.err.join("")).toBe("sbx: bad key (unauthorized, req_1)\n");
	});

	it("a raw-data command puts the error line on stderr unless --json is explicit", () => {
		const a = capture();
		const o = new Output({ ...a, isTTY: false });
		o.rawData = true;
		o.error(apiErr);
		expect(a.out).toEqual([]);
		expect(JSON.parse(a.err.join(""))).toMatchObject({
			event: "error",
			code: "unauthorized",
		});
		const b = capture();
		const j = new Output({ ...b, isTTY: false, explicitJson: true });
		j.rawData = true;
		j.error(apiErr);
		expect(JSON.parse(b.out.join(""))).toMatchObject({ event: "error" });
	});

	it("exit codes: 4 auth, 3 not found, 75 retryable, 1 other, 2 usage", () => {
		const e = (status: number, code: string, retryable = false) =>
			new SbxError({ status, code, message: code, retryable });
		expect(exitCodeOf(e(401, "unauthorized"))).toBe(EXIT_NO_AUTH);
		expect(exitCodeOf(e(401, "token_expired"))).toBe(4);
		expect(exitCodeOf(e(403, "forbidden"))).toBe(4);
		expect(exitCodeOf(e(403, "quota_exceeded"))).toBe(1);
		expect(exitCodeOf(e(0, "no_credentials"))).toBe(4);
		expect(exitCodeOf(e(404, "not_found"))).toBe(EXIT_NOT_FOUND);
		expect(exitCodeOf(e(404, "path_not_found"))).toBe(3);
		expect(exitCodeOf(e(503, "agent_unavailable", true))).toBe(EXIT_TEMPORARY);
		expect(exitCodeOf(e(0, "network_error", true))).toBe(75);
		expect(exitCodeOf(e(409, "invalid_state"))).toBe(1);
		expect(exitCodeOf(e(400, "validation"))).toBe(2);
		expect(exitCodeOf(new Error("x"))).toBe(1);
		expect(
			exitCodeOf(
				new CliError({
					code: "x",
					message: "x",
					retryable: false,
					exitCode: 9,
				}),
			),
		).toBe(9);
	});
});

describe("sbx against the api", () => {
	let w: CliWorld;
	let home: CliHome;
	beforeAll(async () => {
		w = await startWorld();
		home = cliHome();
	});
	afterAll(async () => {
		home?.rm();
		await w?.close();
	});
	const keyEnv = () => ({
		...home.env,
		SBX_API_URL: w.url,
		SBX_API_KEY: w.secret,
	});

	it("whoami without a terminal prints /v1/me as JSON", async () => {
		const r = await runCli(["whoami"], { env: keyEnv() });
		expect(r.code, r.stderr).toBe(0);
		const me = JSON.parse(r.stdout);
		expect(me.user).toBeNull();
		expect(me.team.id).toBe(w.teamId);
		expect(me.auth.kind).toBe("team_key");
		expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
	});

	it("whoami in a terminal prints text; --json there prints JSON", async () => {
		const t = await runCli(["whoami"], { env: keyEnv(), tty: true });
		expect(t.code).toBe(0);
		expect(t.stdout).toMatch(
			/^team key in team .* \(team_[0-9a-z]{26}\); auth: team_key\n$/,
		);
		const j = await runCli(["whoami", "--json"], { env: keyEnv(), tty: true });
		expect(JSON.parse(j.stdout).team.id).toBe(w.teamId);
		const h = await runCli(["--human", "whoami"], { env: keyEnv() });
		expect(h.stdout).toMatch(/^team key in team /);
	});

	it("an API error is the last stdout line with requestId; 401 exits 4", async () => {
		const r = await runCli(["whoami"], {
			env: { ...keyEnv(), SBX_API_KEY: await revokedLookingKey() },
		});
		expect(r.code).toBe(4);
		const last = r.last();
		expect(last).toMatchObject({
			event: "error",
			code: "unauthorized",
			retryable: false,
		});
		expect(last.requestId).toMatch(/^req_[0-9a-z]{26}$/);
		expect(last.details).toBeTypeOf("object");
		expect(r.stderr).toContain("sbx: ");
	});

	it("without credentials: not_logged_in, exit 4; without an API URL: exit 4", async () => {
		const r = await runCli(["whoami"], {
			env: { ...home.env, SBX_API_URL: w.url },
		});
		expect(r.code).toBe(4);
		expect(r.last()).toMatchObject({
			event: "error",
			code: "not_logged_in",
			requestId: null,
		});
		const u = await runCli(["whoami"], { env: home.env });
		expect(u.code).toBe(4);
		expect(u.last()).toMatchObject({ code: "no_api_url" });
	});

	it("bad arguments exit 2 with a usage error line", async () => {
		const r = await runCli(["whoami", "--nope"], { env: keyEnv() });
		expect(r.code).toBe(2);
		expect(r.last()).toMatchObject({
			event: "error",
			code: "usage",
			requestId: null,
		});
		expect(r.last().message as string).toContain("--nope");
		const c = await runCli(["frobnicate"], { env: keyEnv() });
		expect(c.code).toBe(2);
		const s = await runCli(["whoami", "--credential-store", "vault"], {
			env: keyEnv(),
		});
		expect(s.code).toBe(2);
		expect(s.last()).toMatchObject({ code: "usage" });
	});

	it("current: none → exit 3; <sb> makes it current; --clear forgets it; unknown → 3", async () => {
		const env = keyEnv();
		const none = await runCli(["current"], { env });
		expect(none.code).toBe(3);
		expect(none.last()).toMatchObject({
			event: "error",
			code: "no_current_sandbox",
		});

		const sb = await w.createSandbox();
		const set = await runCli(["current", sb.slug], { env });
		expect(set.code, set.stderr).toBe(0);
		expect(JSON.parse(set.stdout).sandbox).toMatchObject({
			id: sb.id,
			slug: sb.slug,
		});

		const get = await runCli(["current"], { env });
		expect(get.code).toBe(0);
		expect(JSON.parse(get.stdout).sandbox.id).toBe(sb.id);
		// Another shell has its own current sandbox.
		const other = await runCli(["current"], {
			env: { ...env, SBX_SESSION: "other-shell" },
		});
		expect(other.code).toBe(3);

		const clear = await runCli(["current", "--clear"], { env });
		expect(clear.code).toBe(0);
		expect(JSON.parse(clear.stdout)).toEqual({ sandbox: null });
		expect((await runCli(["current"], { env })).code).toBe(3);

		const missing = await runCli(["current", "no-such-sandbox-here"], { env });
		expect(missing.code).toBe(3);
		expect(missing.last()).toMatchObject({ event: "error", code: "not_found" });
		expect(missing.last().requestId).toMatch(/^req_/);
	});

	it("version prints the versions; --version prints the CLI version", async () => {
		const r = await runCli(["version"], { env: home.env });
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toMatchObject({
			version: "0.1.0",
			sdk: "0.1.0",
			runtime: expect.stringMatching(/^bun \d/),
		});
		const v = await runCli(["--version"], { env: home.env });
		expect(v.code).toBe(0);
		expect(v.stdout.trim()).toBe("0.1.0");
	});

	it("completion prints scripts with the commands for every shell", async () => {
		for (const shell of ["bash", "zsh", "fish", "powershell"]) {
			const r = await runCli(["completion", shell], { env: home.env });
			expect(r.code, shell).toBe(0);
			for (const word of [
				"login",
				"logout",
				"whoami",
				"auth",
				"current",
				"--json",
			]) {
				expect(r.stdout, `${shell}: ${word}`).toContain(word);
			}
		}
		const bash = await runCli(["completion", "bash"], { env: home.env });
		expect(bash.stdout).toContain("complete -o default -F _sbx sbx");
		expect(bash.stdout).toMatch(/auth\)\n.*token/);
		const bad = await runCli(["completion", "tcsh"], { env: home.env });
		expect(bad.code).toBe(2);
	});

	it("mcp is a placeholder of S11: message on stderr, nothing on stdout, exit 1", async () => {
		const r = await runCli(["mcp", "--toolsets", "core", "--read-only"], {
			env: home.env,
		});
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("implemented by S11");
	});
});

/** A well-formed team key the api does not know. */
async function revokedLookingKey(): Promise<string> {
	const { generateApiKeySecret } = await import("@sbx/auth");
	return generateApiKeySecret();
}
