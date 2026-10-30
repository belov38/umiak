// `sbx shell` through the real CLI (S7 §10, §14.2): a PTY over WebSocket,
// the terminal's input from stdin, its output on stdout, the exit code of
// the terminal's command, SIGWINCH → resize, and --cacert reaching the
// WebSocket behind a self-signed TLS front. The FakeAgent's PTY is a process
// without a terminal (no echo, no line discipline).
import type { ChildProcess } from "node:child_process";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { type CliWorld, startWorld, until } from "./helpers/api.ts";
import { type CliHome, cliHome, runCli } from "./helpers/run-cli.ts";
import { startTlsFront, type TlsFront } from "./helpers/tls.ts";

describe("sbx shell", () => {
	let w: CliWorld;
	let tls: TlsFront;
	let home: CliHome;
	let env: Record<string, string>;
	let sb: { id: string; slug: string };
	beforeAll(async () => {
		w = await startWorld();
		sb = await w.readySandbox();
		tls = await startTlsFront();
		tls.route("/v1/", w.url);
	});
	afterAll(async () => {
		await w?.close();
		await tls?.close();
	});
	beforeEach(() => {
		home = cliHome();
		env = { ...home.env, SBX_API_URL: w.url, SBX_API_KEY: w.secret };
	});
	afterEach(() => home.rm());

	it("runs the command in a PTY with stdin as input and exits with its code", async () => {
		const r = await runCli(
			["shell", sb.slug, "--", 'read l; echo "got $l"; exit 3'],
			{ env, stdin: "hello\n" },
		);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("got hello\n");
		// The explicit sandbox became current; several words are one shell line.
		const two = await runCli(["shell", "--", "echo", "two words"], {
			env,
			stdin: "",
		});
		expect(two.code, two.stderr).toBe(0);
		expect(two.stdout).toBe("two words\n");
	});

	it("sends the terminal size at start (COLUMNS/LINES without a terminal) and again on SIGWINCH", async () => {
		let child: ChildProcess | undefined;
		const before = w.requests.length;
		const run = runCli(["shell", sb.id, "--", 'read l; echo "after $l"'], {
			env: { ...env, COLUMNS: "132", LINES: "43" },
			stdin: "",
			stdinOpen: true,
			onSpawn: (c) => {
				child = c;
			},
		});
		const cmdId = await until(async () => {
			const up = w.requests.slice(before).find((r) => r.startsWith("UPGRADE "));
			// The agent's id of the command: the ULID of cmd_…
			return up?.match(/ptys\/cmd_([^/]+)\/connect/)?.[1]?.toUpperCase();
		});
		await until(async () =>
			w.agent.ptySizes(cmdId).length >= 1 ? true : undefined,
		);
		expect(w.agent.ptySizes(cmdId)[0]).toEqual({ cols: 132, rows: 43 });
		// The handler is installed once the PTY is attached, which the test
		// cannot see: repeat the signal until a resize arrives.
		await until(async () => {
			if (w.agent.ptySizes(cmdId).length >= 2) return true;
			child?.kill("SIGWINCH");
			await new Promise((r) => setTimeout(r, 100));
			return undefined;
		});
		child?.stdin?.end("x\n");
		const r = await run;
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toBe("after x\n");
	});

	it("SIGTERM leaves the terminal running and exits 143; a closed stdout ends the session with 141", async () => {
		let child: ChildProcess | undefined;
		const before = w.requests.length;
		const run = runCli(["shell", sb.id, "--", "sleep 20"], {
			env,
			stdin: "",
			stdinOpen: true,
			onSpawn: (c) => {
				child = c;
			},
		});
		await until(async () =>
			w.requests.slice(before).some((r) => r.startsWith("UPGRADE "))
				? true
				: undefined,
		);
		// Past the attach, when the handlers are in place.
		await new Promise((r) => setTimeout(r, 500));
		child?.kill("SIGTERM");
		const r = await run;
		expect(r.code, r.stderr).toBe(143);
		expect(r.stderr).toContain("--attach cmd_");

		const started = Date.now();
		const head = await runCli(["shell", sb.id, "--", "yes"], {
			env,
			stdinOpen: true,
			closeStdoutAfter: 1,
		});
		expect(head.code, head.stderr).toBe(141);
		expect(head.stderr).toBe("");
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("--cacert reaches the PTY WebSocket behind a self-signed TLS front", async () => {
		const tenv = { ...env, SBX_API_URL: tls.url };
		const bad = await runCli(["shell", sb.id, "--", "echo no"], {
			env: { ...tenv, SBX_RETRY_BUDGET_MS: "500" },
			stdin: "",
		});
		expect(bad.code).toBe(75);
		expect(bad.stderr).toMatch(/certificate|self.signed|SSL|TLS/i);
		const r = await runCli(
			["shell", sb.id, "--cacert", tls.caFile, "--", "echo over tls"],
			{ env: tenv, stdin: "" },
		);
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toBe("over tls\n");
		const e = await runCli(["shell", sb.id, "--", "echo via env"], {
			env: { ...tenv, SBX_CA_FILE: tls.caFile },
			stdin: "",
		});
		expect(e.code, e.stderr).toBe(0);
		expect(e.stdout).toBe("via env\n");
	});
});
