// Input, kill, signal, get and list (S7 §9.4), and access: another
// sandbox's or team's command is 404 on every command route.
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Frame } from "../src/index.ts";
import {
	type Any,
	bytesOf,
	openStream,
	type ReadySandbox,
	readySandbox,
	sleep,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

describe.skipIf(skipPg())("command control", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let h: Harness;
	let sb: ReadySandbox;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		h = w.harness();
		sb = await readySandbox(w);
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	async function start(json: Record<string, unknown>, s = sb): Promise<string> {
		const r = await h.request("POST", s.commands, {
			json: { mode: "detached", ...json },
		});
		expect(r.status).toBe(201);
		return (r.body as Any).id;
	}

	async function finalOf(id: string, s = sb): Promise<Any> {
		for (let i = 0; i < 100; i++) {
			const g = await h.request("GET", `${s.commands}/${id}`);
			if (!["running", "starting"].includes((g.body as Any).status))
				return g.body;
			await sleep(50);
		}
		throw new Error("command did not end");
	}

	it("input: repeats of (sessionId, seq) are applied once; closeStdin ends stdin", async () => {
		const id = await start({ command: "cat", stdin: true });
		const input = (json: unknown) =>
			h.request("POST", `${sb.commands}/${id}/input`, { json });
		expect((await input({ data: "a", sessionId: "s1", seq: 1 })).status).toBe(
			204,
		);
		expect((await input({ data: "a", sessionId: "s1", seq: 1 })).status).toBe(
			204,
		);
		expect((await input({ data: "b", sessionId: "s1", seq: 2 })).status).toBe(
			204,
		);
		// Without a session every request is new.
		expect((await input({ data: "c" })).status).toBe(204);
		expect((await input({ data: "c" })).status).toBe(204);
		expect(
			(
				await input({
					data: Buffer.from("d").toString("base64"),
					encoding: "base64",
				})
			).status,
		).toBe(204);
		expect((await input({ data: "", closeStdin: true })).status).toBe(204);
		const c = await finalOf(id);
		expect(c).toMatchObject({ status: "exited", exitCode: 0 });
		const out = await h.request("GET", `${sb.commands}/${id}/output`);
		expect(out.text).toBe("abccd");

		const exited = await input({ data: "late" });
		expect(exited.status).toBe(409);
		expect((exited.body as Any).error.code).toBe("command_exited");
	});

	it("input validation: sessionId and seq together, base64, no stdin", async () => {
		const id = await start({ command: "sleep 2" });
		const input = (json: unknown) =>
			h.request("POST", `${sb.commands}/${id}/input`, { json });
		expect((await input({ data: "x", sessionId: "s" })).status).toBe(400);
		expect((await input({ data: "x", seq: 1 })).status).toBe(400);
		expect((await input({ data: "@@", encoding: "base64" })).status).toBe(400);
		const noStdin = await input({ data: "x" });
		expect(noStdin.status).toBe(409);
		expect((noStdin.body as Any).error.code).toBe("invalid_state");
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("kill → killed (SIGTERM); a repeat returns the ended command", async () => {
		const id = await start({ command: "sleep 30" });
		const k = await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 2000 },
		});
		expect(k.status).toBe(200);
		expect((k.body as Any).id).toBe(id);
		const s = await openStream(h, "GET", `${sb.commands}/${id}/stream`);
		const frames = await s.rest();
		expect(frames.at(-1)).toMatchObject({
			type: "exit",
			status: "killed",
			signal: "SIGTERM",
			exitCode: 143,
			reason: "signal",
		});
		const again = await h.request("POST", `${sb.commands}/${id}/kill`);
		expect(again.status).toBe(200);
		expect(again.body).toMatchObject({ status: "killed", signal: "SIGTERM" });
		const row = await db.pool.query(
			"SELECT status FROM runtime.commands WHERE id = $1",
			[id.slice(4).toUpperCase()],
		);
		expect(row.rows[0].status).toBe("killed");
	});

	it("signal: a listed signal is delivered; an unknown one is 400", async () => {
		const id = await start({
			command: "trap 'echo got-int; exit 7' INT; sleep 30 & wait",
		});
		await sleep(200);
		const bad = await h.request("POST", `${sb.commands}/${id}/signal`, {
			json: { signal: "SIGWINCH" },
		});
		expect(bad.status).toBe(400);
		expect((bad.body as Any).error.code).toBe("validation");
		const ok = await h.request("POST", `${sb.commands}/${id}/signal`, {
			json: { signal: "SIGINT" },
		});
		expect(ok.status).toBe(200);
		const c = await finalOf(id);
		expect(c).toMatchObject({ status: "exited", exitCode: 7 });
		const out = await h.request("GET", `${sb.commands}/${id}/output`);
		expect(out.text).toBe("got-int\n");
		await h.request("POST", `${sb.commands}/${id}/signal`, {
			json: { signal: "SIGKILL" },
		});
	});

	it("get: live pid and stream sizes while running", async () => {
		const id = await start({ command: "echo hello; sleep 2" });
		await sleep(200);
		const g = await h.request("GET", `${sb.commands}/${id}`);
		expect(g.status).toBe(200);
		expect(g.body).toMatchObject({
			status: "running",
			streams: {
				stdout: { sizeBytes: 6, availableFromBytes: 0, endBytes: null },
			},
		});
		expect((g.body as Any).pid).toBeGreaterThan(0);
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("list: newest first, status and mode filters, signed cursors", async () => {
		const s = await readySandbox(w);
		const a = await start({ command: "true" }, s);
		await finalOf(a, s);
		const b = await start({ command: "sleep 3" }, s);
		const c = await h.request("POST", s.commands, {
			json: { command: "true" },
		});
		const cid = (c.body as Any).command.id;
		const all = await h.request("GET", `${s.commands}?limit=2`);
		expect(all.status).toBe(200);
		expect((all.body as Any).data.map((x: Any) => x.id)).toEqual([cid, b]);
		const next = (all.body as Any).nextCursor;
		expect(next).toEqual(expect.any(String));
		const p2 = await h.request(
			"GET",
			`${s.commands}?limit=2&cursor=${encodeURIComponent(next)}`,
		);
		expect((p2.body as Any).data.map((x: Any) => x.id)).toEqual([a]);
		expect((p2.body as Any).nextCursor).toBeNull();
		const running = await h.request("GET", `${s.commands}?status=running`);
		expect((running.body as Any).data.map((x: Any) => x.id)).toEqual([b]);
		const sync = await h.request("GET", `${s.commands}?mode=sync`);
		expect((sync.body as Any).data.map((x: Any) => x.id)).toEqual([cid]);
		expect((await h.request("GET", `${s.commands}?status=nope`)).status).toBe(
			400,
		);
		const forged = await h.request("GET", `${s.commands}?cursor=abc.def`);
		expect((forged.body as Any).error.code).toBe("invalid_cursor");
		await h.request("POST", `${s.commands}/${b}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("another sandbox's command under this sandbox is 404 on every route; nothing changes", async () => {
		const other = await readySandbox(w);
		const theirs = await start({ command: "sleep 5", stdin: true }, other);
		const foreignTeam = randomUUID();
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[foreignTeam, `t-${foreignTeam}`],
		);
		const foreign = await readySandbox(w, foreignTeam);
		const base = `${sb.commands}/${theirs}`;
		const calls: [string, string, unknown?][] = [
			["GET", base],
			["GET", `${base}/stream`],
			["GET", `${base}/output`],
			["POST", `${base}/input`, { data: "x" }],
			["POST", `${base}/kill`, {}],
			["POST", `${base}/signal`, { signal: "SIGKILL" }],
			["GET", `${foreign.commands}/${theirs}`],
			["POST", `${foreign.commands}/${theirs}/kill`, {}],
			["GET", foreign.commands],
			["GET", `${sb.commands}/cmd_00000000000000000000000000`],
			["GET", `${sb.commands}/not-an-id`],
		];
		for (const [method, path, json] of calls) {
			const r = await h.request(
				method,
				path,
				json === undefined ? {} : { json },
			);
			expect(r.status, `${method} ${path}`).toBe(404);
			expect((r.body as Any).error.code).toBe("not_found");
		}
		const still = await h.request("GET", `${other.commands}/${theirs}`);
		expect((still.body as Any).status).toBe("running");
		await h.request("POST", `${other.commands}/${theirs}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("scopes: commands:read reads, commands:exec is needed for input, kill, signal", async () => {
		const id = await start({ command: "sleep 2" });
		const k = await w.key(["commands:read"]);
		const auth = { authorization: `Bearer ${k.secret}` };
		expect(
			(await h.request("GET", `${sb.commands}/${id}`, { headers: auth }))
				.status,
		).toBe(200);
		expect(
			(await h.request("GET", sb.commands, { headers: auth })).status,
		).toBe(200);
		for (const [path, json] of [
			[`${sb.commands}/${id}/input`, { data: "x" }],
			[`${sb.commands}/${id}/kill`, {}],
			[`${sb.commands}/${id}/signal`, { signal: "SIGINT" }],
		] as const) {
			const r = await h.request("POST", path, { json, headers: auth });
			expect(r.status, path).toBe(403);
		}
		const none = await w.key(["sandboxes:read"]);
		const r = await h.request("GET", `${sb.commands}/${id}/stream`, {
			headers: { authorization: `Bearer ${none.secret}` },
		});
		expect(r.status).toBe(403);
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("frames of /stream are in order per stream with contiguous offsets", async () => {
		const id = await start({
			command: "for i in 1 2 3; do echo o$i; echo e$i >&2; done",
		});
		await finalOf(id);
		const s = await openStream(h, "GET", `${sb.commands}/${id}/stream`);
		const frames: Frame[] = await s.rest();
		const b = bytesOf(frames);
		expect(b.stdout.toString()).toBe("o1\no2\no3\n");
		expect(b.stderr.toString()).toBe("e1\ne2\ne3\n");
	});
});
