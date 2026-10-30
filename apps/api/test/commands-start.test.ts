// POST /v1/sandboxes/{sandbox}/commands (S7 §9.1, §9.2): the three modes,
// validation, capabilities, the wait for a starting sandbox, states and
// access.
import { randomUUID } from "node:crypto";
import { decodeUlid, encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Any,
	openStream,
	type ReadySandbox,
	readySandbox,
	sleep,
	until,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

describe.skipIf(skipPg())("POST /commands", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness({
			deps: {
				commandTimings: {
					readyWaitMs: 400,
					heartbeatMs: 15_000,
					maxDurationMs: 3_600_000,
				},
			},
		});
		sb = await readySandbox(w);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const run = (json: unknown, path = sb.commands, headers = {}) =>
		h.request("POST", path, { json, headers });

	it("sync: 200 with output, exit code and the Command resource", async () => {
		const r = await run({
			command: "echo hi; echo err >&2; exit 3",
			tags: { step: "t" },
		});
		expect(r.status).toBe(200);
		const b = r.body as Any;
		expect(b.stdout).toBe("hi\n");
		expect(b.stderr).toBe("err\n");
		expect(b).toMatchObject({
			stdoutTruncated: false,
			stderrTruncated: false,
			stdoutFrom: 0,
			stderrFrom: 0,
		});
		expect(b.command).toMatchObject({
			mode: "sync",
			command: "echo hi; echo err >&2; exit 3",
			argv: null,
			status: "exited",
			exitCode: 3,
			reason: "none",
			timeoutSeconds: 60,
			tags: { step: "t" },
			sandboxId: sb.ref,
			createdBy: null,
			createdByKey: encodeUuid("apiKey", w.keyId),
			streams: {
				stdout: { sizeBytes: 3, endBytes: 3 },
				stderr: { sizeBytes: 4 },
			},
		});
		expect(b.command.id).toMatch(/^cmd_[0-9a-z]{26}$/);
		expect(r.headers.get("sbx-command-id")).toBe(b.command.id);
		const id = decodeUlid("command", b.command.id) as string;
		const row = await db.pool.query(
			"SELECT status, exit_code, stdout_bytes, stderr_bytes, pid FROM runtime.commands WHERE id = $1",
			[id],
		);
		expect(row.rows[0]).toMatchObject({
			status: "exited",
			exit_code: 3,
			stdout_bytes: "3",
			stderr_bytes: "4",
		});
		expect(Number(row.rows[0].pid)).toBeGreaterThan(0);
	});

	it("sync with argv, cwd, env and base64 encoding", async () => {
		const r = await run({
			argv: ["sh", "-c", 'printf "\\377\\000$V"; pwd >&2'],
			env: { V: "v" },
			cwd: ".",
			encoding: "base64",
		});
		expect(r.status).toBe(200);
		const b = r.body as Any;
		expect(Buffer.from(b.stdout, "base64")).toEqual(
			Buffer.from([0xff, 0, 0x76]),
		);
		expect(Buffer.from(b.stderr, "base64").toString()).toBe(
			`${w.agent.machine(sb.machineId).home}\n`,
		);
		expect(b.command).toMatchObject({
			command: null,
			argv: ["sh", "-c", 'printf "\\377\\000$V"; pwd >&2'],
			envKeys: ["V"],
		});
	});

	it("sync: the process timeout gives timed_out; a missing program failed_to_start", async () => {
		const t = await run({ command: "sleep 10", timeoutSeconds: 1 });
		expect(t.status).toBe(200);
		expect((t.body as Any).command).toMatchObject({
			status: "timed_out",
			reason: "timeout",
			signal: "SIGTERM",
		});
		const f = await run({ argv: ["/nonexistent/prog"] });
		expect(f.status).toBe(200);
		expect((f.body as Any).command).toMatchObject({
			status: "failed_to_start",
			exitCode: 127,
			reason: "start_failed",
		});
		expect((f.body as Any).stderr).toContain("/nonexistent/prog");
	});

	it("stream: 200 NDJSON with Sbx-Command-Id; started first, exit last", async () => {
		const s = await openStream(h, "POST", sb.commands, {
			json: { command: "echo one; echo two >&2", mode: "stream" },
		});
		expect(s.status).toBe(200);
		expect(s.headers.get("content-type")).toBe("application/x-ndjson");
		expect(s.headers.get("cache-control")).toBe("no-store");
		expect(s.headers.get("x-accel-buffering")).toBe("no");
		expect(s.headers.get("request-id")).toMatch(/^req_/);
		const frames = await s.rest();
		const first = frames[0] as Any;
		expect(first).toMatchObject({ type: "started", encoding: "utf8" });
		expect(first.replayed).toBeUndefined();
		expect(first.commandId).toBe(s.headers.get("sbx-command-id"));
		expect(first.pid).toBeGreaterThan(0);
		expect(frames.at(-1)).toMatchObject({
			type: "exit",
			status: "exited",
			exitCode: 0,
			reason: "none",
			stdoutOffset: 4,
			stderrOffset: 4,
		});
		expect(frames.filter((f) => f.type === "stdout")).toEqual([
			{ type: "stdout", offset: 0, nextOffset: 4, data: "one\n" },
		]);
		expect(frames.filter((f) => f.type === "stderr")).toEqual([
			{ type: "stderr", offset: 0, nextOffset: 4, data: "two\n" },
		]);
		// The harness reads it whole and validates every frame as well.
		const again = await run({ command: "true", mode: "stream" });
		expect(again.status).toBe(200);
		expect((again.body as Any[]).map((f) => f.type)).toEqual([
			"started",
			"exit",
		]);
	});

	it("detached: 201 Command at once, the process keeps running", async () => {
		const r = await run({ command: "sleep 0.3; echo done", mode: "detached" });
		expect(r.status).toBe(201);
		const c = r.body as Any;
		expect(c).toMatchObject({
			mode: "detached",
			status: "running",
			timeoutSeconds: null,
		});
		expect(c.pid).toBeGreaterThan(0);
		expect(r.headers.get("sbx-command-id")).toBe(c.id);
		for (let i = 0; i < 50; i++) {
			const g = await h.request("GET", `${sb.commands}/${c.id}`);
			if ((g.body as Any).status === "exited") {
				expect(g.body).toMatchObject({
					exitCode: 0,
					streams: { stdout: { sizeBytes: 5, endBytes: 5 } },
				});
				return;
			}
			await sleep(100);
		}
		throw new Error("detached command did not exit");
	});

	it("validation: exactly one of command and argv; sync timeout up to 600", async () => {
		for (const [json, path] of [
			[{ command: "true", argv: ["true"] }, "argv"],
			[{}, "command"],
			[{ argv: [] }, "argv"],
			[{ command: "true", timeoutSeconds: 601 }, "timeoutSeconds"],
			[
				{ command: "true", mode: "sync", timeoutSeconds: 601 },
				"timeoutSeconds",
			],
			[{ command: "true", timeoutSeconds: null }, "timeoutSeconds"],
			[
				{ command: "true", mode: "sync", timeoutSeconds: null },
				"timeoutSeconds",
			],
			[{ command: "true", failFast: true }, "failFast"],
			[{ command: "true", mode: "pty" }, "mode"],
		] as const) {
			const r = await run(json);
			expect(r.status, JSON.stringify(json)).toBe(400);
			const e = (r.body as Any).error;
			expect(e.code).toBe("validation");
			expect(e.details.issues.map((i: Any) => i.path).join(",")).toContain(
				path,
			);
		}
		const long = await run({
			command: "true",
			mode: "detached",
			timeoutSeconds: 601,
		});
		expect(long.status).toBe(201);
		expect((long.body as Any).timeoutSeconds).toBe(601);
		// No timeout is allowed for stream and detached only.
		const unbounded = await run({
			command: "true",
			mode: "detached",
			timeoutSeconds: null,
		});
		expect(unbounded.status).toBe(201);
		expect((unbounded.body as Any).timeoutSeconds).toBeNull();
	});

	it("agent capabilities: no process.stdin for stdin:true, no process.v1 → 409 agent_outdated", async () => {
		const s = await readySandbox(w);
		const m = w.agent.machine(s.machineId);
		m.capabilities = ["process.v1"];
		const r = await run(
			{ command: "cat", stdin: true, mode: "detached" },
			s.commands,
		);
		expect(r.status).toBe(409);
		expect((r.body as Any).error).toMatchObject({
			code: "agent_outdated",
			details: { capability: "process.stdin" },
		});
		m.capabilities = [];
		const r2 = await run({ command: "true" }, s.commands);
		expect(r2.status).toBe(409);
		expect((r2.body as Any).error.details.capability).toBe("process.v1");
		const rows = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.commands WHERE sandbox_id = $1",
			[s.sandboxId],
		);
		expect(rows.rows[0].n).toBe(0);
	});

	it("a starting sandbox is awaited and the command runs once it is ready", async () => {
		const s = await w.seed({ state: "starting" });
		const ref = encodeUuid("sandbox", s.sandboxId);
		// A wait long enough that markReady below always comes within it (the
		// 400 ms of the shared harness is for the wait that runs out).
		const patient = w.harness({
			deps: {
				commandTimings: {
					readyWaitMs: 60_000,
					heartbeatMs: 15_000,
					maxDurationMs: 3_600_000,
				},
			},
		});
		const pending = patient.request("POST", `/v1/sandboxes/${ref}/commands`, {
			json: { command: "echo ok" },
		});
		// API activity is recorded before the wait (§9.1 step 1).
		await until(async () => {
			const touched = await db.pool.query(
				"SELECT last_api_call_at FROM runtime.sandboxes WHERE id = $1",
				[s.sandboxId],
			);
			return touched.rows[0].last_api_call_at !== null;
		});
		await w.markReady(s.sandboxId);
		const r = await pending;
		expect(r.status).toBe(200);
		expect((r.body as Any).stdout).toBe("ok\n");
	});

	it("still starting after the wait → 409 sandbox_starting (retryable)", async () => {
		const s = await w.seed({ state: "creating" });
		const t0 = Date.now();
		const r = await run(
			{ command: "true" },
			`/v1/sandboxes/${encodeUuid("sandbox", s.sandboxId)}/commands`,
		);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
		expect(r.status).toBe(409);
		expect((r.body as Any).error).toMatchObject({
			code: "sandbox_starting",
			retryable: true,
			details: { state: "creating" },
		});
	});

	it("stopped → 409 sandbox_not_ready; deleted, unknown and another team's → 404", async () => {
		const stopped = await w.seed({ state: "stopped", machineState: "stopped" });
		const r = await run(
			{ command: "true" },
			`/v1/sandboxes/${encodeUuid("sandbox", stopped.sandboxId)}/commands`,
		);
		expect(r.status).toBe(409);
		expect((r.body as Any).error).toMatchObject({
			code: "sandbox_not_ready",
			retryable: false,
			details: { state: "stopped" },
		});
		const deleted = await w.seed({ state: "deleted", machineState: null });
		const foreignTeam = randomUUID();
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[foreignTeam, `t-${foreignTeam}`],
		);
		const foreign = await readySandbox(w, foreignTeam);
		for (const path of [
			`/v1/sandboxes/${encodeUuid("sandbox", deleted.sandboxId)}/commands`,
			`/v1/sandboxes/${encodeUuid("sandbox", randomUUID())}/commands`,
			foreign.commands,
			"/v1/sandboxes/no-such-slug/commands",
		]) {
			const x = await run({ command: "true" }, path);
			expect(x.status, path).toBe(404);
			expect((x.body as Any).error.code).toBe("not_found");
		}
		expect(w.agent.startCount("x", foreign.machineId)).toBe(0);
	});

	it("a key without commands:exec is 403; the slug works as the sandbox ref", async () => {
		const k = await w.key(["sandboxes:read", "commands:read"]);
		const r = await h.request("POST", sb.commands, {
			json: { command: "true" },
			headers: { authorization: `Bearer ${k.secret}` },
		});
		expect(r.status).toBe(403);
		expect((r.body as Any).error.details.requiredScope).toBe("commands:exec");
		const bySlug = await run(
			{ command: "echo s" },
			`/v1/sandboxes/${sb.slug}/commands`,
		);
		expect(bySlug.status).toBe(200);
		expect((bySlug.body as Any).stdout).toBe("s\n");
	});

	it("an agent that refuses Start (too_many_commands) → 409 invalid_state, row failed_to_start", async () => {
		const s = await readySandbox(w);
		const busy = w.agent;
		const before = await db.pool.query(
			"SELECT count(*)::int AS n FROM runtime.commands",
		);
		const spy = busy.start.bind(busy);
		busy.start = async () => {
			const { AgentCallError } = await import("../src/index.ts");
			throw new AgentCallError(
				"too_many_commands",
				"at most 256 commands may run",
			);
		};
		try {
			const r = await run({ command: "true", mode: "detached" }, s.commands);
			expect(r.status).toBe(409);
			expect((r.body as Any).error).toMatchObject({
				code: "invalid_state",
				details: { reason: "too_many_commands" },
			});
		} finally {
			busy.start = spy;
		}
		const rows = await db.pool.query(
			"SELECT status FROM runtime.commands WHERE sandbox_id = $1",
			[s.sandboxId],
		);
		expect(rows.rows.map((x) => x.status)).toEqual(["failed_to_start"]);
		expect(before.rows[0].n).toBeGreaterThan(0);
	});

	it("Start refused with user_not_found → 400 validation, row failed_to_start", async () => {
		const s = await readySandbox(w);
		const agent = w.agent;
		const spy = agent.start.bind(agent);
		agent.start = async () => {
			const { AgentCallError } = await import("../src/index.ts");
			throw new AgentCallError("user_not_found", 'user "bob" not found');
		};
		try {
			const r = await run(
				{ command: "true", mode: "detached", user: "bob" },
				s.commands,
			);
			expect(r.status).toBe(400);
			expect((r.body as Any).error.code).toBe("validation");
		} finally {
			agent.start = spy;
		}
		const rows = await db.pool.query(
			"SELECT status FROM runtime.commands WHERE sandbox_id = $1",
			[s.sandboxId],
		);
		expect(rows.rows.map((x) => x.status)).toEqual(["failed_to_start"]);
	});

	it("Start DeadlineExceeded or Unavailable with a detail → 503 unknown outcome, row stays starting", async () => {
		const { AgentCallError } = await import("../src/index.ts");
		const { AgentUnavailableError } = await import("@sbx/agent-client");
		const ConnectError = Object.getPrototypeOf(AgentUnavailableError) as new (
			message: string,
			code: number,
		) => Error;
		const failures: [string, () => Error][] = [
			["deadline", () => new ConnectError("deadline", 4)],
			["quiesced", () => new AgentCallError("quiesced", "frozen")],
		];
		for (const [name, make] of failures) {
			const s = await readySandbox(w);
			const agent = w.agent;
			const spy = agent.start.bind(agent);
			agent.start = async () => {
				throw make();
			};
			try {
				const r = await run({ command: "true", mode: "detached" }, s.commands);
				expect(r.status, name).toBe(503);
				expect((r.body as Any).error).toMatchObject({
					code: "agent_unavailable",
					retryable: false,
					details: { outcome: "unknown" },
				});
			} finally {
				agent.start = spy;
			}
			const rows = await db.pool.query(
				"SELECT status FROM runtime.commands WHERE sandbox_id = $1",
				[s.sandboxId],
			);
			expect(
				rows.rows.map((x) => x.status),
				name,
			).toEqual(["starting"]);
		}
	});

	it("a capability check cut short by a close of the stream answers the close (401), not 500", async () => {
		const s = await readySandbox(w);
		const agent = w.agent;
		const spy = agent.requireCapability.bind(agent);
		let entered: () => void = () => {};
		const inCheck = new Promise<void>((r) => {
			entered = r;
		});
		agent.requireCapability = (_m: string, _c: string, signal?: AbortSignal) =>
			new Promise<void>((_resolve, reject) => {
				entered();
				signal?.addEventListener("abort", () =>
					reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
				);
			});
		try {
			const pending = run({ command: "true" }, s.commands);
			await inCheck;
			expect(h.deps.streams.revoke({})).toBe(1);
			const r = await pending;
			expect(r.status).toBe(401);
			expect((r.body as Any).error.code).toBe("unauthorized");
		} finally {
			agent.requireCapability = spy;
		}
	});
});
