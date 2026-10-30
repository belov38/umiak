// Commands through the real CLI against the api and the FakeAgent (S7 §14.2,
// §14.3): exec streams stdout and stderr raw and exits with the command's
// code (128+n for a signal, 124 timed out), --json prints frames with
// `event`, --detach prints the id; logs, kill, ps; run creates, executes and
// deletes.
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

describe("exec, logs, kill, ps, run", () => {
	let w: CliWorld;
	let home: CliHome;
	let env: Record<string, string>;
	let sb: { id: string; slug: string };
	beforeAll(async () => {
		w = await startWorld();
		sb = await w.readySandbox();
	});
	afterAll(async () => {
		await w?.close();
	});
	beforeEach(() => {
		home = cliHome();
		env = { ...home.env, SBX_API_URL: w.url, SBX_API_KEY: w.secret };
	});
	afterEach(() => home.rm());

	const sbx = (args: string[], o: { stdin?: string; tty?: boolean } = {}) =>
		runCli(args, { env, ...o });

	it("exec streams stdout to stdout and stderr to stderr and exits with the command's code", async () => {
		const r = await sbx([
			"exec",
			sb.slug,
			"--",
			"sh",
			"-c",
			"echo out; echo err >&2; exit 7",
		]);
		expect(r.code).toBe(7);
		expect(r.stdout).toBe("out\n");
		expect(r.stderr).toBe("err\n");
		// The explicit <sb> became current.
		const again = await sbx(["exec", "--", "echo current"]);
		expect(again.code, again.stderr).toBe(0);
		expect(again.stdout).toBe("current\n");
	});

	it("exec of a command killed by a signal exits 128+n; a timeout exits 124", async () => {
		const sig = await sbx(["exec", sb.id, "--", "sh", "-c", "kill -TERM $$"]);
		expect(sig.code).toBe(128 + 15);
		const t = await sbx(["exec", sb.id, "--timeout", "1", "--", "sleep 5"], {});
		expect(t.code).toBe(124);
	});

	it("exec passes --env, --cwd and --stdin; binary output is byte exact", async () => {
		expect((await sbx(["exec", sb.id, "--", "mkdir -p work"])).code).toBe(0);
		const e = await sbx([
			"exec",
			sb.id,
			"--env",
			"GREETING=hi",
			"--cwd",
			"work",
			"--",
			'echo "$GREETING $(pwd)"',
		]);
		expect(e.code, e.stderr).toBe(0);
		expect(e.stdout).toMatch(/^hi .*\/work\n$/);
		const s = await sbx(["exec", sb.id, "--stdin", "--", "tr a-z A-Z"], {
			stdin: "piped text\n",
		});
		expect(s.code, s.stderr).toBe(0);
		expect(s.stdout).toBe("PIPED TEXT\n");
		// A command that exits without reading stdin does not wait for its end.
		const quick = await runCli(["exec", sb.id, "--stdin", "--", "echo done"], {
			env,
			stdin: "never read\n",
			stdinOpen: true,
			timeoutMs: 10_000,
		});
		expect(quick.code, quick.stderr).toBe(0);
		expect(quick.stdout).toBe("done\n");
		const bin = await sbx([
			"exec",
			sb.id,
			"--",
			"printf '\\303\\251\\377\\000x'",
		]);
		expect(bin.code, bin.stderr).toBe(0);
		expect([...bin.stdoutBytes]).toEqual([0xc3, 0xa9, 0xff, 0x00, 0x78]);
	});

	it("exec --json prints the API frames with `event` instead of `type`", async () => {
		const r = await sbx([
			"exec",
			sb.id,
			"--json",
			"--",
			"sh",
			"-c",
			"echo out; echo err >&2; exit 3",
		]);
		expect(r.code).toBe(3);
		const lines = r.lines();
		expect(lines[0]).toMatchObject({
			event: "started",
			commandId: expect.stringMatching(/^cmd_/),
		});
		expect(lines).toContainEqual(
			expect.objectContaining({ event: "stdout", data: "out\n", offset: 0 }),
		);
		expect(lines).toContainEqual(
			expect.objectContaining({ event: "stderr", data: "err\n" }),
		);
		expect(lines.at(-1)).toMatchObject({
			event: "exit",
			status: "exited",
			exitCode: 3,
		});
		for (const l of lines) expect(l).not.toHaveProperty("type");
	});

	it("exec into a reader that closes early (| head) exits 141 quietly and kills the command", async () => {
		for (const json of [false, true]) {
			const started = Date.now();
			const r = await runCli(
				[
					"exec",
					sb.id,
					...(json ? ["--json"] : []),
					"--tag",
					`pipe=${json}`,
					"--",
					"yes sbx-pipe-test",
				],
				{ env, closeStdoutAfter: 1, timeoutMs: 20_000 },
			);
			expect(r.code, r.stderr).toBe(141);
			expect(r.stderr).toBe("");
			expect(Date.now() - started).toBeLessThan(15_000);
			// The remote `yes` was killed.
			const ps = await sbx(["ps", sb.id, "--json"]);
			const cmd = (
				ps.last().data as { id: string; tags: Record<string, string> }[]
			).find((c) => c.tags.pipe === String(json));
			expect(cmd).toBeDefined();
			const logs = await sbx([
				"logs",
				sb.id,
				cmd?.id ?? "",
				"-f",
				"--tail",
				"1",
				"--json",
			]);
			expect(logs.last()).toMatchObject({ event: "exit", status: "killed" });
		}
	});

	it("SBX_OUTPUT=json does not turn exec into frames: stdout stays the bytes", async () => {
		const r = await runCli(["exec", sb.id, "--", "echo raw"], {
			env: { ...env, SBX_OUTPUT: "json" },
		});
		expect(r.code, r.stderr).toBe(0);
		expect(r.stdout).toBe("raw\n");
	});

	it("exec flag combinations are checked before any request", async () => {
		const r = await sbx([
			"exec",
			"no-such-box-here",
			"--detach",
			"--stdin",
			"--",
			"true",
		]);
		expect(r.code).toBe(2);
		const t = await sbx([
			"exec",
			"no-such-box-here",
			"--timeout",
			"soon",
			"--",
			"true",
		]);
		expect(t.code).toBe(2);
		expect((await sbx(["current"])).code).toBe(3);
	});

	it("exec --help explains one word (shell) vs several (argv)", async () => {
		const r = await sbx(["exec", "--help"]);
		expect(r.stdout).toContain("bash -lc");
		expect(r.stdout).toMatch(/argv/);
	});

	it("Ctrl-C while run waits for ready deletes the sandbox and exits 130", async () => {
		const tag = crypto.randomUUID();
		let child: ChildProcess | undefined;
		const run = runCli(["run", "--label", `run=${tag}`, "--", "true"], {
			env,
			onSpawn: (c) => {
				child = c;
			},
		});
		const slug = await until(async () => {
			const r = await w.db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE labels->>'run' = $1",
				[tag],
			);
			return r.rows[0]?.slug;
		});
		await new Promise((r) => setTimeout(r, 300));
		child?.kill("SIGINT");
		const r = await run;
		expect(r.code, r.stderr).toBe(130);
		const state = await w.db.pool.query<{ state: string }>(
			"SELECT state FROM runtime.sandboxes WHERE slug = $1",
			[slug],
		);
		expect(state.rows[0]?.state).toBe("deleting");
	});

	it("exec errors: no `--` is a usage error; an unknown sandbox exits 3 with the error on stderr", async () => {
		const u = await sbx(["exec", sb.id]);
		expect(u.code).toBe(2);
		const nf = await sbx(["exec", "no-such-box-here", "--", "true"]);
		expect(nf.code).toBe(3);
		expect(nf.stdout).toBe("");
		expect(JSON.parse(nf.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject(
			{
				event: "error",
			},
		);
	});

	it("exec --detach prints the command id; logs, logs -f, ps and kill", async () => {
		const d = await sbx([
			"exec",
			sb.id,
			"--detach",
			"--",
			"echo first; echo second >&2; sleep 1; echo third",
		]);
		expect(d.code, d.stderr).toBe(0);
		const id = d.stdout.trim();
		expect(id).toMatch(/^cmd_/);
		const f = await sbx(["logs", sb.id, id, "-f"]);
		expect(f.code, f.stderr).toBe(0);
		expect(f.stdout).toBe("first\nthird\n");
		expect(f.stderr).toBe("second\n");
		const all = await sbx(["logs", id]);
		expect(all.stdout).toBe("first\nthird\n");
		const tail = await sbx(["logs", sb.id, id, "--tail", "6"]);
		expect(tail.stdout).toBe("third\n");

		const long = await sbx(["exec", sb.id, "--detach", "--", "sleep 30"]);
		const longId = long.stdout.trim();
		const ps = await sbx(["ps", sb.id]);
		expect(ps.code, ps.stderr).toBe(0);
		const listed = JSON.parse(ps.stdout).data as {
			id: string;
			status: string;
		}[];
		expect(listed.find((c) => c.id === longId)).toMatchObject({
			status: "running",
		});
		const running = await sbx(["ps", sb.id, "--status", "running"]);
		expect(
			JSON.parse(running.stdout).data.map((c: { id: string }) => c.id),
		).toEqual([longId]);
		const k = await sbx(["kill", sb.id, longId, "--signal", "SIGKILL"]);
		expect(k.code, k.stderr).toBe(0);
		expect(JSON.parse(k.stdout).id).toBe(longId);
		const ended = await sbx(["logs", sb.id, longId, "-f", "--json"]);
		expect(ended.last()).toMatchObject({
			event: "exit",
			status: "killed",
			signal: "SIGKILL",
		});
		await until(async () => {
			const r = await sbx(["ps", sb.id, "--status", "running"]);
			return JSON.parse(r.stdout).data.length === 0 ? true : undefined;
		});
		const table = await sbx(["ps", sb.id], { tty: true });
		expect(table.stdout).toMatch(/ID\s+STATUS/);
	});

	it("logs --json prints frames with `event`", async () => {
		const d = await sbx(["exec", sb.id, "--detach", "--", "echo framed"]);
		const id = d.stdout.trim();
		const r = await sbx(["logs", sb.id, id, "-f", "--json"]);
		expect(r.code, r.stderr).toBe(0);
		const lines = r.lines();
		expect(lines).toContainEqual(
			expect.objectContaining({ event: "stdout", data: "framed\n" }),
		);
		expect(lines.at(-1)).toMatchObject({ event: "exit", exitCode: 0 });
	});

	it("run creates a sandbox, executes, deletes it and exits with the command's code", async () => {
		const tag = crypto.randomUUID();
		const run = sbx([
			"run",
			"--label",
			`run=${tag}`,
			"--",
			"sh",
			"-c",
			"echo ran; exit 4",
		]);
		const slug = await until(async () => {
			const r = await w.db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE labels->>'run' = $1",
				[tag],
			);
			return r.rows[0]?.slug;
		});
		await w.markReady(slug);
		const r = await run;
		expect(r.code, r.stderr).toBe(4);
		expect(r.stdout).toBe("ran\n");
		const state = await w.db.pool.query<{ state: string }>(
			"SELECT state FROM runtime.sandboxes WHERE slug = $1",
			[slug],
		);
		expect(state.rows[0]?.state).toBe("deleting");
		// A temporary sandbox does not become current.
		expect((await sbx(["current"])).code).toBe(3);
	});

	it("run --keep keeps the sandbox and makes it current", async () => {
		const tag = crypto.randomUUID();
		const run = sbx(["run", "--keep", "--label", `run=${tag}`, "--", "true"]);
		const slug = await until(async () => {
			const r = await w.db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE labels->>'run' = $1",
				[tag],
			);
			return r.rows[0]?.slug;
		});
		await w.markReady(slug);
		const r = await run;
		expect(r.code, r.stderr).toBe(0);
		const cur = JSON.parse((await sbx(["current"])).stdout);
		expect(cur.sandbox).toMatchObject({ slug, state: "ready" });
	});
});
