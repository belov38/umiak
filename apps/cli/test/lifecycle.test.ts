// Sandbox lifecycle, catalog, snapshots and environments through the real
// CLI against the api (S7 §14.2, §14.3, §16 "Контракт CLI"): waiting
// commands print JSON Lines ending in ready/stopped, rm needs a TTY or
// --yes and sends Sbx-Confirm-Delete, create/fork/explicit <sb> set the
// current sandbox.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("sandbox lifecycle", () => {
	let w: CliWorld;
	let home: CliHome;
	let env: Record<string, string>;
	beforeAll(async () => {
		w = await startWorld();
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

	/** The slug of the one sandbox labelled `run=<tag>` once it is in `state`. */
	const slugOf = (tag: string, state = "creating") =>
		until(async () => {
			const r = await w.db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE labels->>'run' = $1 AND state = $2",
				[tag, state],
			);
			return r.rows[0]?.slug;
		});

	it("create --wait without a TTY prints JSONL: accepted first, ready last; it becomes current", async () => {
		const tag = crypto.randomUUID();
		const run = sbx([
			"create",
			"--label",
			`run=${tag}`,
			"--env",
			"A=1",
			"--secret",
			"S=two",
			"--ttl",
			"1h",
			"--idle",
			"10m",
			"--name",
			"ci run",
			"--wait",
		]);
		const slug = await slugOf(tag);
		await new Promise((r) => setTimeout(r, 300));
		await w.markReady(slug);
		const r = await run;
		expect(r.code, r.stderr).toBe(0);
		const lines = r.lines();
		expect(lines[0]).toMatchObject({
			event: "accepted",
			sandbox: {
				slug,
				state: "creating",
				name: "ci run",
				labels: { run: tag },
			},
			operation: { kind: "create" },
		});
		expect(lines.at(-1)).toMatchObject({
			event: "ready",
			sandbox: {
				slug,
				state: "ready",
				ttlSeconds: 3600,
				idleTimeoutSeconds: 600,
			},
		});
		for (const l of lines.slice(1, -1)) {
			expect(l).toMatchObject({ event: "state" });
		}
		const id = (lines[0] as { sandbox: { id: string } }).sandbox.id;
		const cur = await sbx(["current"]);
		expect(cur.code).toBe(0);
		expect(JSON.parse(cur.stdout).sandbox.id).toBe(id);
		// The sets reached the sandbox; secret values are never printed.
		const e = await sbx(["env"]);
		expect(e.code, e.stderr).toBe(0);
		expect(JSON.parse(e.stdout)).toMatchObject({
			env: { A: "1" },
			secretKeys: ["S"],
		});
		expect(e.stdout).not.toContain("two");
	});

	it("create without --wait prints {sandbox, operation}; --env-file; human text in a TTY", async () => {
		const file = join(home.dir, "vars.env");
		writeFileSync(
			file,
			'# comment\nexport FROM_FILE=yes\nQUOTED="a b"\nA=file\n',
		);
		const r = await sbx([
			"create",
			"--env-file",
			file,
			"--env",
			"A=flag",
			"--slug",
			`box-${crypto.randomUUID().slice(0, 8)}x`,
		]);
		expect(r.code, r.stderr).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.sandbox.state).toBe("creating");
		expect(out.operation.kind).toBe("create");
		const e = await sbx(["env", out.sandbox.slug]);
		expect(JSON.parse(e.stdout).env).toEqual({
			FROM_FILE: "yes",
			QUOTED: "a b",
			A: "flag",
		});
		const human = await sbx(["info", out.sandbox.id], { tty: true });
		expect(human.code).toBe(0);
		expect(human.stdout).toContain(out.sandbox.slug);
		expect(human.stdout).toContain("creating");
		const bad = await sbx(["create", "--env", "NOEQUALS"]);
		expect(bad.code).toBe(2);
		expect(bad.last()).toMatchObject({ event: "error", code: "usage" });
	});

	it("create --wait: a sandbox that fails ends with the error line, exit 1", async () => {
		const tag = crypto.randomUUID();
		const run = sbx(["create", "--label", `run=${tag}`, "--wait"]);
		const slug = await slugOf(tag);
		await w.markError(slug);
		const r = await run;
		expect(r.code).toBe(1);
		const lines = r.lines();
		expect(lines[0]).toMatchObject({ event: "accepted" });
		expect(lines.at(-1)).toMatchObject({
			event: "error",
			code: "sandbox_failed",
			details: { state: "error" },
		});
	});

	it("list filters by label and state; info by slug; unknown → 3", async () => {
		const tag = crypto.randomUUID();
		const a = await w.createSandbox();
		const create = await sbx(["create", "--label", `run=${tag}`]);
		const b = JSON.parse(create.stdout).sandbox;
		const l = await sbx(["list", "--label", `run=${tag}`]);
		expect(l.code, l.stderr).toBe(0);
		const list = JSON.parse(l.stdout);
		expect(list.data.map((s: { id: string }) => s.id)).toEqual([b.id]);
		expect(list.nextCursor).toBeNull();
		const byState = await sbx(["list", "--state", "creating,ready"]);
		const ids = JSON.parse(byState.stdout).data.map(
			(s: { id: string }) => s.id,
		);
		expect(ids).toContain(a.id);
		const limited = await sbx(["list", "--limit", "1"]);
		const page = JSON.parse(limited.stdout);
		expect(page.data).toHaveLength(1);
		expect(page.nextCursor).toEqual(expect.any(String));
		const table = await sbx(["list", "--label", `run=${tag}`], { tty: true });
		expect(table.stdout).toMatch(/SLUG\s+ID\s+STATE/);
		expect(table.stdout).toContain(b.slug);
		const info = await sbx(["info", b.slug]);
		expect(JSON.parse(info.stdout).id).toBe(b.id);
		const missing = await sbx(["info", "no-such-box-here"]);
		expect(missing.code).toBe(3);
		expect(missing.last()).toMatchObject({
			event: "error",
			requestId: expect.stringMatching(/^req_/),
		});
	});

	it("stop --wait ends with stopped; resume --wait with ready; recover without --wait", async () => {
		const sb = await w.readySandbox();
		const stop = sbx(["stop", sb.slug, "--wait"]);
		await until(async () => {
			const r = await w.db.pool.query<{ state: string }>(
				"SELECT state FROM runtime.sandboxes WHERE slug = $1",
				[sb.slug],
			);
			return r.rows[0]?.state === "stopping" ? true : undefined;
		});
		await new Promise((r) => setTimeout(r, 200));
		await w.markStopped(sb.slug);
		const s = await stop;
		expect(s.code, s.stderr).toBe(0);
		const sl = s.lines();
		expect(sl[0]).toMatchObject({
			event: "accepted",
			sandbox: { id: sb.id, state: "stopping" },
			operation: { kind: "stop" },
		});
		expect(sl.at(-1)).toMatchObject({
			event: "stopped",
			sandbox: { id: sb.id, state: "stopped" },
		});
		// The explicit <sb> became current: resume without an argument.
		const resume = sbx(["resume", "--env", "R=1", "--wait"]);
		await until(async () => {
			const r = await w.db.pool.query<{ state: string }>(
				"SELECT state FROM runtime.sandboxes WHERE slug = $1",
				[sb.slug],
			);
			return r.rows[0]?.state === "starting" ? true : undefined;
		});
		await w.markReady(sb.slug);
		const rs = await resume;
		expect(rs.code, rs.stderr).toBe(0);
		expect(rs.lines()[0]).toMatchObject({
			event: "accepted",
			operation: { kind: "resume" },
		});
		expect(rs.lines().at(-1)).toMatchObject({
			event: "ready",
			sandbox: { state: "ready" },
		});
		expect(JSON.parse((await sbx(["env"])).stdout).env).toMatchObject({
			R: "1",
		});
		const rec = await sbx(["recover", sb.id]);
		expect(rec.code, rec.stderr).toBe(0);
		expect(JSON.parse(rec.stdout)).toMatchObject({
			sandbox: { id: sb.id, state: "starting" },
			operation: { kind: "recover" },
		});
	});

	it("fork --wait prints the copy's JSONL and makes the copy current", async () => {
		const sb = await w.readySandbox();
		const tag = crypto.randomUUID();
		const fork = sbx([
			"fork",
			sb.slug,
			"--name",
			"copy",
			"--label",
			`run=${tag}`,
			"--wait",
		]);
		const slug = await slugOf(tag);
		await w.markReady(slug);
		const r = await fork;
		expect(r.code, r.stderr).toBe(0);
		const lines = r.lines();
		expect(lines[0]).toMatchObject({
			event: "accepted",
			sandbox: { slug, name: "copy" },
			operation: { kind: "create" },
			sourceOperation: { kind: "fork" },
		});
		expect(lines.at(-1)).toMatchObject({ event: "ready", sandbox: { slug } });
		const cur = JSON.parse((await sbx(["current"])).stdout);
		expect(cur.sandbox.slug).toBe(slug);
	});

	it("rm without --yes and without a TTY exits 2 and deletes nothing; --yes deletes", async () => {
		const sb = await w.readySandbox();
		const no = await sbx(["rm", sb.slug]);
		expect(no.code).toBe(2);
		expect(no.last()).toMatchObject({ event: "error", code: "usage" });
		const still = await sbx(["info", sb.id]);
		expect(JSON.parse(still.stdout).state).toBe("ready");
		const yes = await sbx(["rm", sb.slug, "--yes"]);
		expect(yes.code, yes.stderr).toBe(0);
		// The api deletes only with Sbx-Confirm-Delete (428 otherwise).
		expect(JSON.parse(yes.stdout)).toMatchObject({
			sandbox: { id: sb.id, state: "deleting" },
			operation: { kind: "delete" },
		});
		const raw = await fetch(`${w.url}/v1/sandboxes/${sb.id}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${w.secret}` },
		});
		expect(raw.status).toBe(428);
	});

	it("rm in a terminal asks: n keeps, y deletes; several at once; the deleted current is forgotten", async () => {
		const a = await w.readySandbox();
		const b = await w.readySandbox();
		const keep = await sbx(["rm", a.slug, b.slug], { tty: true, stdin: "n\n" });
		expect(keep.code).toBe(1);
		expect(keep.stderr).toContain(a.slug);
		expect(keep.stderr).toMatch(/\[y\/N\]/);
		expect(JSON.parse((await sbx(["info", a.id])).stdout).state).toBe("ready");
		await sbx(["current", a.id]);
		const del = await sbx(["--json", "rm", a.slug, b.slug], {
			tty: true,
			stdin: "y\n",
		});
		expect(del.code, del.stderr).toBe(0);
		// JSON: one array of the answers, not one document per sandbox.
		const answers = JSON.parse(del.stdout) as { sandbox: { id: string } }[];
		expect(answers.map((x) => x.sandbox.id)).toEqual([a.id, b.id]);
		expect((await sbx(["current"])).code).toBe(3);
		expect(JSON.parse((await sbx(["info", a.id])).stdout).state).toBe(
			"deleting",
		);
		expect(JSON.parse((await sbx(["info", b.id])).stdout).state).toBe(
			"deleting",
		);
	});

	it("rename, extend and label", async () => {
		const sb = await w.readySandbox();
		const slug = `renamed-${crypto.randomUUID().slice(0, 8)}x`;
		const r = await sbx(["rename", sb.id, slug]);
		expect(r.code, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout)).toMatchObject({ id: sb.id, slug });
		const ext = await sbx(["extend", slug, "--ttl", "2h"]);
		expect(ext.code, ext.stderr).toBe(0);
		expect(Date.parse(JSON.parse(ext.stdout).deadlineAt)).toBeGreaterThan(
			Date.now() + 7_000_000,
		);
		const l1 = await sbx(["label", slug, "a=1", "b=2"]);
		expect(JSON.parse(l1.stdout).labels).toEqual({ a: "1", b: "2" });
		// <sb> omitted: the current sandbox (set by the explicit <sb> above).
		const l2 = await sbx(["label", "b=3", "--unset", "a"]);
		expect(l2.code, l2.stderr).toBe(0);
		expect(JSON.parse(l2.stdout).labels).toEqual({ b: "3" });
	});

	it("env: show; --set, --secret, --unset merge (secret values never printed)", async () => {
		const sb = await w.readySandbox();
		const set = await sbx([
			"env",
			sb.id,
			"--set",
			"A=1",
			"--set",
			"B=2",
			"--secret",
			"TOKEN=hidden",
		]);
		expect(set.code, set.stderr).toBe(0);
		expect(JSON.parse(set.stdout)).toMatchObject({
			env: { A: "1", B: "2" },
			secretKeys: ["TOKEN"],
			delivered: expect.any(Boolean),
		});
		expect(set.stdout).not.toContain("hidden");
		const unset = await sbx(["env", sb.id, "--unset", "A", "--unset", "TOKEN"]);
		expect(unset.code, unset.stderr).toBe(0);
		expect(JSON.parse(unset.stdout)).toMatchObject({
			env: { B: "2" },
			secretKeys: [],
		});
		const show = await sbx(["env", sb.id], { tty: true });
		expect(show.stdout).toContain("B=2");
	});

	it("snapshot save --wait, list, rm (needs --yes without a TTY)", async () => {
		const sb = await w.readySandbox();
		const name = `snap-${crypto.randomUUID().slice(0, 8)}`;
		const save = sbx(["snapshot", "save", sb.slug, name, "--wait"]);
		await until(async () => {
			const r = await w.db.pool.query(
				"SELECT 1 FROM runtime.snapshots WHERE pending_name = $1",
				[name],
			);
			return r.rowCount ? true : undefined;
		});
		await w.markSnapshotReady(name);
		const s = await save;
		expect(s.code, s.stderr).toBe(0);
		// JSON Lines like the other waiting commands: accepted first, ready last.
		const lines = s.lines();
		expect(lines[0]).toMatchObject({
			event: "accepted",
			snapshot: { state: "creating" },
			operation: { kind: "save_snapshot" },
		});
		expect(lines.at(-1)).toMatchObject({
			event: "ready",
			snapshot: { name, state: "ready" },
		});
		expect(lines).toHaveLength(2);
		const list = await sbx(["snapshot", "list"]);
		expect(
			JSON.parse(list.stdout).data.map((x: { name: string }) => x.name),
		).toContain(name);
		const no = await sbx(["snapshot", "rm", name]);
		expect(no.code).toBe(2);
		const rm = await sbx(["snapshot", "rm", name, "--yes"]);
		expect(rm.code, rm.stderr).toBe(0);
		const after = await sbx(["snapshot", "list"]);
		expect(
			JSON.parse(after.stdout).data.map((x: { name: string }) => x.name),
		).not.toContain(name);
		const noWait = await sbx(["snapshot", "save", sb.id, `${name}-2`]);
		expect(JSON.parse(noWait.stdout)).toMatchObject({
			snapshot: { name: `${name}-2`, state: "creating" },
			operation: { kind: "save_snapshot" },
		});
	});

	it("snapshot save --wait: a failed snapshot ends with the error line, exit 1; text in a TTY", async () => {
		const sb = await w.readySandbox();
		const name = `snap-${crypto.randomUUID().slice(0, 8)}`;
		const save = sbx(["snapshot", "save", sb.slug, name, "--wait"]);
		await until(async () => {
			const r = await w.db.pool.query(
				`UPDATE runtime.operations
				 SET state = 'failed', finished_at = now(),
				     error_code = 'snapshot_failed', error_message = 'lvcreate failed', retryable = false
				 WHERE sandbox_id = (SELECT source_sandbox_id FROM runtime.snapshots WHERE pending_name = $1)
				   AND kind = 'save_snapshot' AND state IN ('pending', 'running')`,
				[name],
			);
			return r.rowCount ? true : undefined;
		});
		const s = await save;
		expect(s.code).toBe(1);
		const lines = s.lines();
		expect(lines[0]).toMatchObject({ event: "accepted" });
		expect(lines.at(-1)).toMatchObject({
			event: "error",
			code: "snapshot_failed",
			message: "lvcreate failed",
		});

		const human = `snap-${crypto.randomUUID().slice(0, 8)}`;
		const tty = sbx(["snapshot", "save", sb.id, human, "--wait"], {
			tty: true,
		});
		await until(async () => {
			const r = await w.db.pool.query(
				"SELECT 1 FROM runtime.snapshots WHERE pending_name = $1",
				[human],
			);
			return r.rowCount ? true : undefined;
		});
		await w.markSnapshotReady(human);
		const t = await tty;
		expect(t.code, t.stderr).toBe(0);
		expect(t.stdout).toMatch(
			new RegExp(`^Saving ${human} \\(snap_[^)]+\\): creating\\n`),
		);
		expect(t.stdout).toMatch(
			new RegExp(`${human} \\(snap_[^)]+\\): ready\\n$`),
		);
	});

	describe("--force-stop of a running Windows sandbox (S9 §24.8)", () => {
		let windowsMachine: string | undefined;
		const setOs = (machineId: string, os: "linux" | "windows") =>
			w.db.pool.query(
				"UPDATE runtime.template_builds SET os = $2 WHERE id = (SELECT template_build_id FROM runtime.machines WHERE id = $1)",
				[machineId, os],
			);
		afterEach(async () => {
			if (windowsMachine !== undefined) await setOs(windowsMachine, "linux");
			windowsMachine = undefined;
		});
		const windowsSandbox = async () => {
			const sb = await w.readySandbox();
			const r = await w.db.pool.query<{ machine_id: string }>(
				"SELECT machine_id FROM runtime.sandboxes WHERE slug = $1",
				[sb.slug],
			);
			windowsMachine = r.rows[0]?.machine_id as string;
			await setOs(windowsMachine, "windows");
			return sb;
		};

		it("fork without --force-stop prints the API message and the hint; with it the request carries forceStop", async () => {
			const sb = await windowsSandbox();
			const r = await sbx(["fork", sb.slug]);
			expect(r.code).toBe(1);
			expect(r.last()).toMatchObject({
				event: "error",
				code: "snapshot_requires_stop",
				details: { retryWith: { forceStop: true }, cli: "--force-stop" },
			});
			expect(r.stderr).toContain(
				"sbx: Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true",
			);
			expect(r.stderr).toContain("\nhint: use --force-stop");
			const tty = await sbx(["fork", sb.slug], { tty: true });
			expect(tty.stderr).toContain("hint: use --force-stop");

			const ok = await sbx(["fork", sb.slug, "--force-stop"]);
			expect(ok.code, ok.stderr).toBe(0);
			expect(JSON.parse(ok.stdout)).toMatchObject({
				sourceOperation: { kind: "fork", forceStop: { sourceStopped: false } },
			});
		});

		it("snapshot save: the hint without --force-stop; with --wait a failed restart is a warning", async () => {
			const sb = await windowsSandbox();
			const name = `snap-${crypto.randomUUID().slice(0, 8)}`;
			const no = await sbx(["snapshot", "save", sb.slug, name]);
			expect(no.code).toBe(1);
			expect(no.last()).toMatchObject({ code: "snapshot_requires_stop" });
			expect(no.stderr).toContain(
				"sbx: Windows snapshots are saved from a stopped VM",
			);
			expect(no.stderr).toContain("hint: use --force-stop");

			const save = sbx([
				"snapshot",
				"save",
				sb.slug,
				name,
				"--force-stop",
				"--wait",
			]);
			await until(async () => {
				const r = await w.db.pool.query(
					`UPDATE runtime.operations
					 SET progress = progress || '{"forceStopped": true, "sourceRestarted": false,
					   "restartError": {"code": "agent_timeout", "message": "no agent"}}'::jsonb
					 WHERE sandbox_id = (SELECT source_sandbox_id FROM runtime.snapshots WHERE pending_name = $1)
					   AND kind = 'save_snapshot' AND state IN ('pending', 'running')`,
					[name],
				);
				return r.rowCount ? true : undefined;
			});
			await w.markSnapshotReady(name);
			const s = await save;
			expect(s.code, s.stderr).toBe(0);
			expect(s.lines()[0]).toMatchObject({
				event: "accepted",
				operation: {
					kind: "save_snapshot",
					forceStop: { sourceStopped: false },
				},
			});
			expect(s.lines().at(-1)).toMatchObject({ event: "ready" });
			expect(s.stderr).toContain(
				"warning: the source sandbox was stopped for the snapshot but failed to start again: no agent (agent_timeout); resume it: sbx resume sb_",
			);
		});
	});

	it("templates, sizes and limits", async () => {
		const t = await sbx(["templates"]);
		expect(t.code, t.stderr).toBe(0);
		expect(JSON.parse(t.stdout).data[0]).toMatchObject({
			slug: expect.any(String),
			defaultSize: expect.any(String),
		});
		const s = await sbx(["sizes"]);
		expect(JSON.parse(s.stdout).data[0]).toMatchObject({
			slug: expect.any(String),
			vcpu: expect.any(Number),
		});
		const l = await sbx(["limits"]);
		expect(JSON.parse(l.stdout)).toMatchObject({
			quota: expect.any(Object),
			canCreate: expect.any(Boolean),
		});
		const human = await sbx(["templates"], { tty: true });
		expect(human.stdout).toMatch(/SLUG\s+NAME/);
	});

	it("env-sets: create, list, show, set, unset, rm; create --environment applies one", async () => {
		const name = `es-${crypto.randomUUID().slice(0, 8)}`;
		const c = await sbx([
			"env-sets",
			"create",
			name,
			"--env",
			"FROM_SET=1",
			"--secret",
			"SET_SECRET=s",
		]);
		expect(c.code, c.stderr).toBe(0);
		expect(JSON.parse(c.stdout)).toMatchObject({
			name,
			env: { FROM_SET: "1" },
			secretKeys: ["SET_SECRET"],
			revision: 1,
		});
		const list = await sbx(["env-sets", "list"]);
		expect(
			JSON.parse(list.stdout).data.map((x: { name: string }) => x.name),
		).toContain(name);
		const set = await sbx(["env-sets", "set", name, "--env", "MORE=2"]);
		expect(JSON.parse(set.stdout)).toMatchObject({
			env: { FROM_SET: "1", MORE: "2" },
			revision: 2,
		});
		const unset = await sbx([
			"env-sets",
			"unset",
			name,
			"FROM_SET",
			"SET_SECRET",
		]);
		expect(JSON.parse(unset.stdout)).toMatchObject({
			env: { MORE: "2" },
			secretKeys: [],
		});
		const show = await sbx(["env-sets", "show", name]);
		expect(JSON.parse(show.stdout).env).toEqual({ MORE: "2" });
		const created = await sbx(["create", "--environment", name]);
		expect(created.code, created.stderr).toBe(0);
		const id = JSON.parse(created.stdout).sandbox.id;
		expect(JSON.parse((await sbx(["env", id])).stdout).env).toMatchObject({
			MORE: "2",
		});
		const rm = await sbx(["env-sets", "rm", name]);
		expect(rm.code, rm.stderr).toBe(0);
		expect((await sbx(["env-sets", "show", name])).code).toBe(3);
	});
});
