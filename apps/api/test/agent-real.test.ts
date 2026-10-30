// The api against the REAL guest agent (S3) behind the real S2 gateway, in
// one helper process (services/guest-agent/cmd/sbx-agent-harness, built by
// agent-harness-global.ts): ConnectAgentApi over AgentClient + PgRegistry
// on the test database, through the public routes. Commands are host
// processes driven by the harness's fake shim (see runner.go there).
//
// What the fake OS dependencies cannot do, and how the tests deal with it:
// - commands run as the current OS user, not as `user` (no such account on
//   a developer machine, no uid switch): requests pass `user` = that
//   account. The home of that user is mapped to the harness's scratch
//   directory: for commands (cwd, HOME) by the fake shim, for the
//   Filesystem API and /files* by the harness rewriting `~`, relative and
//   real-home paths before they reach the agent (homeGuard).
// - no cgroups: leftovers and OOM kills are not covered;
// - ports come from a fake procfs with one listener (0.0.0.0:8080);
// - the machine is not claimed (no worker): env delivery is not covered.
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApiServer, type Frame, PTY_SUBPROTOCOL } from "../src/index.ts";
import {
	type Any,
	bytesOf as frameBytes,
	openStream,
	type ReadySandbox,
	readySandbox,
	shellGate,
	until,
	WAIT_MS,
} from "./helpers/commands.ts";
import {
	bytesOf,
	filesUrl,
	qs,
	rawRequest,
	tarEntry,
	tarOf,
} from "./helpers/files.ts";
import type { Harness } from "./helpers/harness.ts";
import {
	type RealAgent,
	realAgentSkip,
	startRealAgent,
} from "./helpers/real-agent.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const skipReason = skipPg() ? "" : realAgentSkip();
if (skipReason !== "") {
	// Visible in the run output: the tests below are skipped, not passed.
	console.warn(`agent-real.test.ts: ${skipReason}`);
}

const sha256 = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");
const err = (r: { body: unknown }) => (r.body as Any).error;

describe.skipIf(skipPg() || skipReason !== "")(
	"the api against the real agent",
	() => {
		let db: TestDatabase;
		let w: ApiWorld;
		let h: Harness;
		let sb: ReadySandbox;
		let real: RealAgent;
		/** OS user the commands run as. */
		let user: string;
		/** Scratch directory: the home of the commands, root of the file tests. */
		let work: string;

		beforeAll(async () => {
			db = await createTestDatabase({ max: 20 });
			w = await apiWorld(db.pool);
			sb = await readySandbox(w);
			real = await startRealAgent(db, sb.machineId);
			user = real.info.user;
			work = real.info.workDir;
			h = w.harness({ deps: { agent: real.agent } });
		});
		afterAll(async () => {
			await real?.close();
			await w?.close();
			await db?.drop();
		});

		const run = (json: Record<string, unknown>, headers = {}) =>
			h.request("POST", sb.commands, { json: { user, ...json }, headers });

		async function detached(json: Record<string, unknown>): Promise<string> {
			const r = await run({ mode: "detached", ...json });
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			return (r.body as Any).id;
		}

		/** The Command once it is no longer running. */
		function ended(id: string): Promise<Any> {
			return until(
				async () => {
					const g = await h.request("GET", `${sb.commands}/${id}`);
					const c = g.body as Any;
					return c.status !== "running" && c.status !== "starting" && c;
				},
				WAIT_MS,
				`command ${id} to end`,
			);
		}

		it("the session is served with the S3 capabilities", async () => {
			expect(real.info.capabilities).toEqual(
				expect.arrayContaining([
					"process.v1",
					"process.pty",
					"process.stdin",
					"files.v1",
					"files.upload.v1",
					"files.archive.v1",
					"system.ports.v1",
				]),
			);
			expect(await real.agent.capabilities(sb.machineId)).toEqual(
				real.info.capabilities,
			);
		});

		describe("commands", () => {
			it("sync: output, exit code, the Command resource and the row", async () => {
				const r = await run({ command: "echo hi; echo err >&2; exit 3" });
				expect(r.status, JSON.stringify(r.body)).toBe(200);
				const b = r.body as Any;
				expect(b.stdout).toBe("hi\n");
				expect(b.stderr).toBe("err\n");
				expect(b.command).toMatchObject({
					mode: "sync",
					status: "exited",
					exitCode: 3,
					reason: "none",
					signal: null,
					outputTruncated: null,
					streams: {
						stdout: { sizeBytes: 3, endBytes: 3 },
						stderr: { sizeBytes: 4, endBytes: 4 },
					},
				});
				expect(b.command.pid).toBeGreaterThan(0);
				expect(Date.parse(b.command.startedAt)).toBeGreaterThan(0);
				expect(Date.parse(b.command.endedAt)).toBeGreaterThan(0);
			});

			it("sync with argv, env and base64; cwd defaults to the home", async () => {
				const r = await run({
					argv: ["sh", "-c", 'printf "\\377\\000$V"; pwd >&2'],
					env: { V: "v" },
					encoding: "base64",
				});
				expect(r.status).toBe(200);
				const b = r.body as Any;
				expect(Buffer.from(b.stdout, "base64")).toEqual(
					Buffer.from([0xff, 0, 0x76]),
				);
				expect(Buffer.from(b.stderr, "base64").toString()).toBe(`${work}\n`);
				expect(b.command).toMatchObject({ envKeys: ["V"], exitCode: 0 });
			});

			it("exit statuses: timeout (timed_out, SIGTERM), a missing program (failed_to_start, 127)", async () => {
				const t = await run({ command: "sleep 30", timeoutSeconds: 1 });
				expect(t.status).toBe(200);
				expect((t.body as Any).command).toMatchObject({
					status: "timed_out",
					reason: "timeout",
					signal: "SIGTERM",
					exitCode: 143,
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

			it("stream: started first, output frames by stream, exit last with the offsets", async () => {
				const s = await openStream(h, "POST", sb.commands, {
					json: { user, command: "echo one; echo two >&2", mode: "stream" },
				});
				expect(s.status).toBe(200);
				const frames = await s.rest();
				expect(frames[0]).toMatchObject({ type: "started" });
				expect((frames[0] as Any).pid).toBeGreaterThan(0);
				expect(frames.at(-1)).toMatchObject({
					type: "exit",
					status: "exited",
					exitCode: 0,
					stdoutOffset: 4,
					stderrOffset: 4,
				});
				const b = frameBytes(frames);
				expect(b.stdout.toString()).toBe("one\n");
				expect(b.stderr.toString()).toBe("two\n");
			});

			it("detached, then /stream from offsets, with tailBytes, and /output", async () => {
				const id = await detached({
					command: "printf 0123456789; printf abcdef >&2",
				});
				const c = await ended(id);
				expect(c).toMatchObject({
					status: "exited",
					exitCode: 0,
					streams: {
						stdout: { sizeBytes: 10, endBytes: 10 },
						stderr: { sizeBytes: 6, endBytes: 6 },
					},
				});
				const from = await openStream(
					h,
					"GET",
					`${sb.commands}/${id}/stream?stdoutOffset=4&stderrOffset=2`,
				);
				const ff = await from.rest();
				expect(ff[0]).toMatchObject({
					type: "attached",
					stdoutOffset: 4,
					stderrOffset: 2,
				});
				const fb = frameBytes(ff, "utf8", { stdout: 4, stderr: 2 });
				expect(fb.stdout.toString()).toBe("456789");
				expect(fb.stderr.toString()).toBe("cdef");
				expect(ff.at(-1)).toMatchObject({
					type: "exit",
					stdoutOffset: 10,
					stderrOffset: 6,
				});

				const tail = await openStream(
					h,
					"GET",
					`${sb.commands}/${id}/stream?tailBytes=3`,
				);
				const tf = await tail.rest();
				expect(tf[0]).toMatchObject({
					type: "attached",
					stdoutOffset: 7,
					stderrOffset: 3,
				});
				const tb = frameBytes(tf, "utf8", { stdout: 7, stderr: 3 });
				expect(tb.stdout.toString()).toBe("789");
				expect(tb.stderr.toString()).toBe("def");

				const out = await h.request(
					"GET",
					`${sb.commands}/${id}/output?offset=3&limit=4`,
				);
				expect(out.status).toBe(200);
				expect(out.text).toBe("3456");

				const past = await h.request(
					"GET",
					`${sb.commands}/${id}/stream?stdoutOffset=11`,
				);
				expect(past.status).toBe(416);
				expect(err(past).code).toBe("range_not_satisfiable");
			});

			it("follow=false: what exists now and the end; no exit while it runs", async () => {
				const gate = shellGate();
				const id = await detached({
					command: `echo early; ${gate.shell}; echo late`,
				});
				const r = await until(async () => {
					const r = await h.request(
						"GET",
						`${sb.commands}/${id}/stream?follow=false`,
					);
					return (r.body as Frame[]).length > 1 && r;
				});
				const frames = r.body as Frame[];
				expect(frames.map((f) => f.type)).toEqual(["attached", "stdout"]);
				expect(frames[1]).toMatchObject({ data: "early\n", nextOffset: 6 });
				gate.open();
				await ended(id);
				const done = await h.request(
					"GET",
					`${sb.commands}/${id}/stream?follow=false&stdoutOffset=6`,
				);
				const after = done.body as Frame[];
				expect(after.map((f) => f.type)).toEqual([
					"attached",
					"stdout",
					"exit",
				]);
				expect(after[1]).toMatchObject({ offset: 6, data: "late\n" });
			});

			it("input with sessionId and seq: repeats are dropped, closeStdin ends cat", async () => {
				const id = await detached({ command: "cat", stdin: true });
				const input = (json: unknown) =>
					h.request("POST", `${sb.commands}/${id}/input`, { json });
				expect(
					(await input({ data: "a", sessionId: "s1", seq: 1 })).status,
				).toBe(204);
				expect(
					(await input({ data: "b", sessionId: "s1", seq: 2 })).status,
				).toBe(204);
				// A repeat of seq 2 (a retry): dropped by the shim.
				expect(
					(await input({ data: "b", sessionId: "s1", seq: 2 })).status,
				).toBe(204);
				// Without a session every request is new.
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
				const c = await ended(id);
				expect(c).toMatchObject({ status: "exited", exitCode: 0 });
				const out = await h.request("GET", `${sb.commands}/${id}/output`);
				expect(out.text).toBe("abcd");
				const late = await input({ data: "late" });
				expect(late.status).toBe(409);
				expect(err(late).code).toBe("command_exited");
			});

			it("input to a command without stdin is 409 invalid_state", async () => {
				const id = await detached({ command: "sleep 30" });
				try {
					const r = await h.request("POST", `${sb.commands}/${id}/input`, {
						json: { data: "x", sessionId: "s", seq: 1 },
					});
					expect(r.status).toBe(409);
					expect(err(r)).toMatchObject({ code: "invalid_state" });
				} finally {
					await h.request("POST", `${sb.commands}/${id}/kill`, {
						json: { graceMs: 0 },
					});
				}
			});

			it("signal SIGINT ends sleep: killed, 130", async () => {
				const id = await detached({ command: "sleep 30" });
				const s = await h.request("POST", `${sb.commands}/${id}/signal`, {
					json: { signal: "SIGINT" },
				});
				expect(s.status, JSON.stringify(s.body)).toBe(200);
				expect((s.body as Any).id).toBe(id);
				const c = await ended(id);
				expect(c).toMatchObject({
					status: "killed",
					signal: "SIGINT",
					exitCode: 130,
					reason: "signal",
				});
				const bad = await h.request("POST", `${sb.commands}/${id}/signal`, {
					json: { signal: "SIGNOPE" },
				});
				expect(bad.status).toBe(400);
				// After the end: the Command unchanged, as FakeAgent answers.
				const late = await h.request("POST", `${sb.commands}/${id}/signal`, {
					json: { signal: "SIGTERM" },
				});
				expect(late.status, JSON.stringify(late.body)).toBe(200);
				expect((late.body as Any).status).toBe("killed");
			});

			it("kill: SIGTERM ends it (killed); kill of an ended command answers it unchanged", async () => {
				const id = await detached({ command: "sleep 30" });
				const k = await h.request("POST", `${sb.commands}/${id}/kill`, {
					json: { graceMs: 0 },
				});
				expect(k.status, JSON.stringify(k.body)).toBe(200);
				const c = await ended(id);
				expect(c).toMatchObject({ status: "killed", signal: "SIGTERM" });
				expect(c.exitCode).toBe(143);
				const again = await h.request("POST", `${sb.commands}/${id}/kill`, {
					json: { graceMs: 0 },
				});
				expect(again.status).toBe(200);
				expect((again.body as Any).status).toBe("killed");
			});

			it("Start with an Idempotency-Key: one process, the replay answers it", async () => {
				const key = `real-${randomBytes(4).toString("hex")}`;
				const a = await run(
					{ command: "echo once", mode: "detached" },
					{ "idempotency-key": key },
				);
				expect(a.status).toBe(201);
				const b = await run(
					{ command: "echo once", mode: "detached" },
					{ "idempotency-key": key },
				);
				expect(b.status).toBe(200);
				expect((b.body as Any).id).toBe((a.body as Any).id);
				const c = await ended((a.body as Any).id);
				expect(c.streams.stdout.endBytes).toBe(5);
			});

			it("an unknown user is 400 validation (user_not_found)", async () => {
				const r = await run({ command: "true", user: "no-such-user-sbx" });
				expect(r.status).toBe(400);
				expect(err(r).code).toBe("validation");
			});
		});

		describe("PTY over WebSocket", () => {
			let base: string;
			let closeServer: () => Promise<void>;
			const sockets: WebSocket[] = [];

			beforeAll(async () => {
				const { server } = createApiServer(h.app);
				await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
				base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
				closeServer = () =>
					new Promise<void>((r) => {
						server.closeAllConnections();
						server.close(() => r());
					});
			});
			afterAll(async () => {
				for (const s of sockets) s.terminate();
				await closeServer?.();
			});

			interface Client {
				ws: WebSocket;
				texts: Any[];
				chunks: Buffer[];
				bytes(): Buffer;
				closed: Promise<number>;
			}

			function connect(id: string, query = ""): Client {
				const ws = new WebSocket(
					`${base}/v1/sandboxes/${sb.ref}/ptys/${id}/connect${query}`,
					[PTY_SUBPROTOCOL],
					{ headers: { authorization: `Bearer ${w.secret}` } },
				);
				sockets.push(ws);
				const c: Client = {
					ws,
					texts: [],
					chunks: [],
					bytes: () => Buffer.concat(c.chunks),
					closed: new Promise((r) => ws.once("close", (code) => r(code))),
				};
				ws.on("error", () => {});
				ws.on("message", (data, binary) => {
					const b = Buffer.isBuffer(data)
						? data
						: Buffer.from(data as ArrayBuffer);
					if (binary) c.chunks.push(b);
					else c.texts.push(JSON.parse(b.toString("utf8")));
				});
				return c;
			}

			async function createPty(json: Record<string, unknown>): Promise<string> {
				const r = await h.request("POST", `/v1/sandboxes/${sb.ref}/ptys`, {
					json: { cols: 80, rows: 24, user, ...json },
				});
				expect(r.status, JSON.stringify(r.body)).toBe(201);
				expect((r.body as Any).mode).toBe("pty");
				return (r.body as Any).id;
			}

			// Reads lines; `size` prints the terminal size, `bye` exits 0.
			const LOOP = `while IFS= read -r l; do if [ "$l" = size ]; then stty size; elif [ "$l" = bye ]; then exit 0; else echo "got:$l"; fi; done`;

			it("connect, echo, resize, reconnect by offset, exit and close 1000", async () => {
				const id = await createPty({ command: LOOP, cols: 90, rows: 30 });
				const a = connect(id);
				await until(() => a.texts.length > 0, WAIT_MS, "attached");
				expect(a.texts[0]).toEqual({ type: "attached", offset: 0 });
				a.ws.send(Buffer.from("hello\n"));
				await until(
					() => a.bytes().toString().includes("got:hello"),
					WAIT_MS,
					"echo",
				);
				// The initial size, then a resize by control frame.
				a.ws.send(Buffer.from("size\n"));
				await until(
					() => a.bytes().toString().includes("30 90"),
					WAIT_MS,
					"stty size 30 90",
				);
				a.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
				// The size goes through Process/Update; poll until stty sees it.
				await until(
					async () => {
						a.ws.send(Buffer.from("size\n"));
						await new Promise((r) => setTimeout(r, 50));
						return a.bytes().toString().includes("40 100");
					},
					WAIT_MS,
					"stty size 40 100",
				);
				// POST .../resize too.
				const rs = await h.request(
					"POST",
					`/v1/sandboxes/${sb.ref}/ptys/${id}/resize`,
					{ json: { cols: 120, rows: 50 } },
				);
				expect(rs.status).toBe(204);

				// Drop the socket; reconnect from the bytes received.
				const seen = a.bytes();
				a.ws.terminate();
				await a.closed;
				const b = connect(id, `?offset=${seen.length}`);
				await until(() => b.texts.length > 0, WAIT_MS, "attached again");
				expect(b.texts[0]).toEqual({ type: "attached", offset: seen.length });
				b.ws.send(Buffer.from("size\n"));
				await until(
					() => b.bytes().toString().includes("50 120"),
					WAIT_MS,
					"stty size 50 120",
				);
				// Nothing of the first connection is repeated.
				expect(b.bytes().toString()).not.toContain("got:hello");
				b.ws.send(Buffer.from("bye\n"));
				expect(await b.closed).toBe(1000);
				expect(b.texts.at(-1)).toMatchObject({
					type: "exit",
					status: "exited",
					exitCode: 0,
				});
				const total = seen.length + b.bytes().length;
				expect(b.texts.at(-1).ptyOffset).toBe(total);

				// The whole output from the start equals both connections.
				const all = connect(id);
				expect(await all.closed).toBe(1000);
				expect(all.bytes()).toEqual(Buffer.concat([seen, b.bytes()]));
				const c = await ended(id);
				expect(c.streams.pty).toMatchObject({
					sizeBytes: total,
					endBytes: total,
				});
				// A resize after the end: 409 command_exited, as FakeAgent answers.
				const late = await h.request(
					"POST",
					`/v1/sandboxes/${sb.ref}/ptys/${id}/resize`,
					{ json: { cols: 80, rows: 24 } },
				);
				expect(late.status).toBe(409);
				expect(err(late).code).toBe("command_exited");
			});

			it("offset past the end of an exited PTY closes 4416", async () => {
				const id = await createPty({ command: "printf abcdef" });
				const first = connect(id);
				expect(await first.closed).toBe(1000);
				const size = first.bytes().length;
				const past = connect(id, `?offset=${size + 5}`);
				expect(await past.closed).toBe(4416);
				expect(past.texts.at(-1)).toMatchObject({
					type: "error",
					code: "range_not_satisfiable",
				});
			});
		});

		describe("files", () => {
			const url = (rest: string, q: Record<string, string | undefined> = {}) =>
				filesUrl(sb.ref, `${rest}${Object.keys(q).length ? qs(q) : ""}`);
			const p = (rel: string) => join(work, rel);

			it("PUT content, GET with Range and If-Range, HEAD", async () => {
				const data = randomBytes(5000);
				const put = await h.request(
					"PUT",
					url("/content", { path: p("c/data.bin") }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: data,
					},
				);
				expect(put.status, JSON.stringify(put.body)).toBe(200);
				expect(put.body).toMatchObject({
					path: p("c/data.bin"),
					name: "data.bin",
					type: "file",
					sizeBytes: 5000,
				});
				expect(readFileSync(p("c/data.bin")).equals(data)).toBe(true);

				const full = await rawRequest(
					h,
					"GET",
					url("/content", { path: p("c/data.bin") }),
				);
				expect(full.status).toBe(200);
				expect(full.headers.get("accept-ranges")).toBe("bytes");
				expect(full.headers.get("content-length")).toBe("5000");
				const etag = full.headers.get("etag") ?? "";
				expect(etag).not.toBe("");
				expect((await bytesOf(full)).equals(data)).toBe(true);

				const range = await rawRequest(
					h,
					"GET",
					url("/content", { path: p("c/data.bin") }),
					{
						headers: { range: "bytes=10-19" },
					},
				);
				expect(range.status).toBe(206);
				expect(range.headers.get("content-range")).toBe("bytes 10-19/5000");
				expect((await bytesOf(range)).equals(data.subarray(10, 20))).toBe(true);

				const same = await rawRequest(
					h,
					"GET",
					url("/content", { path: p("c/data.bin") }),
					{
						headers: { range: "bytes=10-19", "if-range": etag },
					},
				);
				expect(same.status).toBe(206);
				await bytesOf(same);
				const other = await rawRequest(
					h,
					"GET",
					url("/content", { path: p("c/data.bin") }),
					{
						headers: { range: "bytes=10-19", "if-range": '"1-2-3"' },
					},
				);
				expect(other.status).toBe(200);
				expect((await bytesOf(other)).length).toBe(5000);

				const head = await rawRequest(
					h,
					"HEAD",
					url("/content", { path: p("c/data.bin") }),
				);
				expect(head.status).toBe(200);
				expect(head.headers.get("content-length")).toBe("5000");

				const unsat = await h.request(
					"GET",
					url("/content", { path: p("c/data.bin") }),
					{
						headers: { range: "bytes=9000-" },
					},
				);
				expect(unsat.status).toBe(416);
				expect(unsat.headers.get("content-range")).toBe("bytes */5000");

				const missing = await h.request(
					"GET",
					url("/content", { path: p("c/none") }),
				);
				expect(missing.status).toBe(404);
				expect(err(missing).code).toBe("path_not_found");
			});

			it("uploads: chunks, HEAD offset, a wrong offset, commit with sha256 and a mismatch", async () => {
				const data = randomBytes(300_000);
				const begin = async (path: string) => {
					const r = await h.request("POST", url("/uploads"), {
						json: { path },
					});
					expect(r.status, JSON.stringify(r.body)).toBe(201);
					return (r.body as Any).uploadId as string;
				};
				const chunk = (id: string, offset: number, body: Uint8Array) =>
					h.request("PUT", url(`/uploads/${id}`, { offset: String(offset) }), {
						headers: { "content-type": "application/octet-stream" },
						body: body as Uint8Array<ArrayBuffer>,
					});
				const id = await begin(p("u/up.bin"));
				const one = await chunk(id, 0, data.subarray(0, 100_000));
				expect(one.status, JSON.stringify(one.body)).toBe(200);
				expect(one.body).toEqual({ offset: 100_000 });
				const head = await rawRequest(h, "HEAD", url(`/uploads/${id}`));
				expect(head.status).toBe(200);
				expect(head.headers.get("sbx-upload-offset")).toBe("100000");
				const wrong = await chunk(id, 0, data.subarray(0, 10));
				expect(wrong.status).toBe(409);
				expect(err(wrong)).toMatchObject({
					code: "upload_offset_mismatch",
					details: { offset: 100_000 },
				});
				const two = await chunk(id, 100_000, data.subarray(100_000));
				expect(two.body).toEqual({ offset: 300_000 });
				const commit = await h.request("POST", url(`/uploads/${id}/commit`), {
					json: { path: p("u/up.bin"), sha256: sha256(data), mode: 0o600 },
				});
				expect(commit.status, JSON.stringify(commit.body)).toBe(200);
				expect(commit.body).toMatchObject({
					path: p("u/up.bin"),
					type: "file",
					sizeBytes: 300_000,
					mode: 0o600,
				});
				expect(sha256(readFileSync(p("u/up.bin")))).toBe(sha256(data));

				const bad = await begin(p("u/bad.bin"));
				await chunk(bad, 0, Buffer.from("hello"));
				const mismatch = await h.request(
					"POST",
					url(`/uploads/${bad}/commit`),
					{
						json: { path: p("u/bad.bin"), sha256: "0".repeat(64) },
					},
				);
				expect(mismatch.status).toBe(422);
				expect(err(mismatch).code).toBe("checksum_mismatch");
				expect(existsSync(p("u/bad.bin"))).toBe(false);
				const gone = await rawRequest(h, "HEAD", url(`/uploads/${bad}`));
				expect(gone.status).toBe(404);
			});

			it("stat, list, mkdir, move, chmod, delete", async () => {
				mkdirSync(p("ops"), { recursive: true });
				writeFileSync(p("ops/a.txt"), "12345");
				writeFileSync(p("ops/.hidden"), "h");

				const st = await h.request(
					"GET",
					url("/stat", { path: p("ops/a.txt") }),
				);
				expect(st.status).toBe(200);
				expect(st.body).toMatchObject({
					path: p("ops/a.txt"),
					name: "a.txt",
					type: "file",
					sizeBytes: 5,
					owner: user,
					symlinkTarget: null,
				});
				expect(Date.parse((st.body as Any).modifiedAt)).toBeGreaterThan(0);
				const none = await h.request(
					"GET",
					url("/stat", { path: p("ops/none") }),
				);
				expect(none.status).toBe(404);
				expect(err(none).code).toBe("path_not_found");

				const mk = await h.request("POST", url("/mkdir"), {
					json: { path: p("ops/d/e"), parents: true, mode: 0o750 },
				});
				expect(mk.status, JSON.stringify(mk.body)).toBe(201);
				expect(mk.body).toMatchObject({ type: "dir", mode: 0o750 });
				const again = await h.request("POST", url("/mkdir"), {
					json: { path: p("ops/d/e"), parents: true },
				});
				expect(again.status).toBe(200);
				const noParent = await h.request("POST", url("/mkdir"), {
					json: { path: p("ops/x/y") },
				});
				expect(noParent.status).toBe(404);
				expect(err(noParent).code).toBe("path_not_found");

				const list = await h.request("GET", url("/list", { path: p("ops") }));
				expect(list.status).toBe(200);
				const names = ((list.body as Any).data as Any[])
					.map((e) => e.name)
					.sort();
				expect(names).toEqual([".hidden", "a.txt", "d"]);
				const visible = await h.request(
					"GET",
					url("/list", {
						path: p("ops"),
						includeHidden: "false",
					}),
				);
				expect(
					((visible.body as Any).data as Any[]).map((e) => e.name).sort(),
				).toEqual(["a.txt", "d"]);
				const deep = await h.request(
					"GET",
					url("/list", { path: p("ops"), depth: "3" }),
				);
				expect(((deep.body as Any).data as Any[]).map((e) => e.path)).toContain(
					p("ops/d/e"),
				);
				const paged = await h.request(
					"GET",
					url("/list", { path: p("ops"), limit: "1" }),
				);
				expect((paged.body as Any).data).toHaveLength(1);
				expect((paged.body as Any).nextCursor).toEqual(expect.any(String));
				const page2 = await h.request(
					"GET",
					url("/list", {
						path: p("ops"),
						limit: "1",
						cursor: (paged.body as Any).nextCursor,
					}),
				);
				expect(page2.status).toBe(200);
				expect((page2.body as Any).data[0].name).not.toBe(
					(paged.body as Any).data[0].name,
				);

				const mv = await h.request("POST", url("/move"), {
					json: { from: p("ops/a.txt"), to: p("ops/d/b.txt") },
				});
				expect(mv.status, JSON.stringify(mv.body)).toBe(200);
				expect(mv.body).toMatchObject({ path: p("ops/d/b.txt"), sizeBytes: 5 });
				writeFileSync(p("ops/c.txt"), "c");
				const clash = await h.request("POST", url("/move"), {
					json: { from: p("ops/c.txt"), to: p("ops/d/b.txt") },
				});
				expect(clash.status).toBe(409);
				expect(err(clash).code).toBe("already_exists");
				const over = await h.request("POST", url("/move"), {
					json: { from: p("ops/c.txt"), to: p("ops/d/b.txt"), overwrite: true },
				});
				expect(over.status).toBe(200);
				expect(readFileSync(p("ops/d/b.txt"), "utf8")).toBe("c");

				const ch = await h.request("POST", url("/chmod"), {
					json: { path: p("ops/d/b.txt"), mode: 0o600 },
				});
				expect(ch.status, JSON.stringify(ch.body)).toBe(200);
				expect((ch.body as Any).mode).toBe(0o600);

				const notEmpty = await h.request(
					"DELETE",
					url("", { path: p("ops/d") }),
				);
				expect(notEmpty.status).toBe(409);
				expect(err(notEmpty)).toMatchObject({
					code: "invalid_state",
					details: { agentCode: "failed_precondition" },
				});
				const del = await h.request(
					"DELETE",
					url("", {
						path: p("ops/d"),
						recursive: "true",
					}),
				);
				expect(del.status).toBe(200);
				expect(del.body).toEqual({ existed: true });
				expect(existsSync(p("ops/d"))).toBe(false);
				const delAgain = await h.request(
					"DELETE",
					url("", { path: p("ops/d") }),
				);
				expect(delAgain.body).toEqual({ existed: false });
			});

			it("archive: GET then PUT elsewhere round trips; ../ in an archive is 400 invalid_path", async () => {
				mkdirSync(p("proj/src/deep"), { recursive: true });
				writeFileSync(p("proj/README.md"), "# proj\n");
				writeFileSync(p("proj/src/main.bin"), randomBytes(200_000));
				writeFileSync(p("proj/src/deep/x.txt"), "x".repeat(10_000));
				for (const format of ["tar", "tar.gz"]) {
					const get = await rawRequest(
						h,
						"GET",
						url("/archive", {
							path: p("proj"),
							format,
						}),
					);
					expect(get.status).toBe(200);
					const body = await bytesOf(get);
					const dst = p(`copy-${format}`);
					const put = await rawRequest(
						h,
						"PUT",
						url("/archive", { path: dst, format }),
						{
							headers: { "content-type": "application/octet-stream" },
							body: new Uint8Array(body),
						},
					);
					expect(put.status).toBe(200);
					const result = (await put.json()) as Any;
					expect(result).toMatchObject({
						path: dst,
						sizeBytes: 200_000 + 10_000 + 7,
					});
					for (const rel of ["README.md", "src/main.bin", "src/deep/x.txt"]) {
						expect(sha256(readFileSync(join(dst, rel)))).toBe(
							sha256(readFileSync(p(`proj/${rel}`))),
						);
					}
				}
				const evil = await h.request(
					"PUT",
					url("/archive", { path: p("hostile") }),
					{
						headers: { "content-type": "application/x-tar" },
						body: tarOf(tarEntry("../evil", "0", "x")),
					},
				);
				expect(evil.status).toBe(400);
				expect(err(evil)).toMatchObject({
					code: "invalid_path",
					details: { entriesWritten: 0 },
				});
				expect(existsSync(p("evil"))).toBe(false);
				expect(
					existsSync(p("hostile")) ? readdirSync(p("hostile")) : [],
				).toEqual([]);
				const notDir = await h.request(
					"GET",
					url("/archive", { path: p("proj/README.md") }),
				);
				expect(notDir.status).toBe(409);
				expect(err(notDir).code).toBe("not_directory");
			});

			it("~, relative paths and the real home land in the scratch dir, never in $HOME", async () => {
				const name = `sbx-guard-${randomBytes(6).toString("hex")}`;
				const inHome = (rel: string) => join(homedir(), rel);
				const created = [
					`${name}.txt`,
					`${name}-dir`,
					`${name}-up.bin`,
					`${name}-arc`,
				];
				for (const n of created) expect(existsSync(inHome(n))).toBe(false);

				const home = await h.request("GET", url("/stat", { path: "~" }));
				expect((home.body as Any).path).toBe(work);
				const put = await h.request(
					"PUT",
					url("/content", { path: `~/${name}.txt` }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: "tilde",
					},
				);
				expect(put.status, JSON.stringify(put.body)).toBe(200);
				expect((put.body as Any).path).toBe(p(`${name}.txt`));
				const mk = await h.request("POST", url("/mkdir"), {
					json: { path: `${name}-dir/sub`, parents: true },
				});
				expect(mk.status, JSON.stringify(mk.body)).toBe(201);
				expect((mk.body as Any).path).toBe(p(`${name}-dir/sub`));
				// An absolute path in the real home is the scratch dir as well.
				const abs = await h.request(
					"GET",
					url("/stat", { path: inHome(`${name}.txt`) }),
				);
				expect((abs.body as Any).path).toBe(p(`${name}.txt`));
				const mv = await h.request("POST", url("/move"), {
					json: { from: `~/${name}.txt`, to: `${name}-dir/moved.txt` },
				});
				expect(mv.status, JSON.stringify(mv.body)).toBe(200);
				const up = await h.request("POST", url("/uploads"), {
					json: { path: `${name}-up.bin` },
				});
				const id = (up.body as Any).uploadId as string;
				await h.request(
					"PUT",
					url(`/uploads/${id}`, { offset: "0", path: `${name}-up.bin` }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: "up",
					},
				);
				const commit = await h.request("POST", url(`/uploads/${id}/commit`), {
					json: { path: `${name}-up.bin`, sha256: sha256("up") },
				});
				expect(commit.status, JSON.stringify(commit.body)).toBe(200);
				expect((commit.body as Any).path).toBe(p(`${name}-up.bin`));
				const arc = await h.request(
					"PUT",
					url("/archive", { path: `${name}-arc` }),
					{
						headers: { "content-type": "application/x-tar" },
						body: tarOf(tarEntry("a.txt", "0", "a")),
					},
				);
				expect(arc.status, JSON.stringify(arc.body)).toBe(200);
				const del = await h.request(
					"DELETE",
					url("", { path: `~/${name}-dir`, recursive: "true" }),
				);
				expect(del.body).toEqual({ existed: true });

				expect(readFileSync(p(`${name}-up.bin`), "utf8")).toBe("up");
				expect(readFileSync(p(`${name}-arc/a.txt`), "utf8")).toBe("a");
				for (const n of created) expect(existsSync(inHome(n))).toBe(false);

				// Enough ".." to climb from the scratch dir into $HOME: refused.
				const dots = "../".repeat(work.split("/").length - 1);
				const climb = `${dots}${homedir().slice(1)}/${name}-climb`;
				const viaRpc = await h.request("POST", url("/mkdir"), {
					json: { path: climb },
				});
				expect(
					viaRpc.status,
					JSON.stringify(viaRpc.body),
				).toBeGreaterThanOrEqual(400);
				const viaHttp = await h.request(
					"PUT",
					url("/content", { path: `~/${climb}` }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: "x",
					},
				);
				expect(viaHttp.status).toBeGreaterThanOrEqual(400);
				const upc = await h.request("POST", url("/uploads"), {
					json: { path: `${name}-c.bin` },
				});
				const cid = (upc.body as Any).uploadId as string;
				await h.request(
					"PUT",
					url(`/uploads/${cid}`, { offset: "0", path: `${name}-c.bin` }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: "c",
					},
				);
				const viaCommit = await h.request(
					"POST",
					url(`/uploads/${cid}/commit`),
					{
						json: { path: climb, sha256: sha256("c") },
					},
				);
				expect(viaCommit.status).toBeGreaterThanOrEqual(400);
				expect(existsSync(inHome(`${name}-climb`))).toBe(false);
			});

			it("files and commands see the same directory", async () => {
				const put = await h.request(
					"PUT",
					url("/content", { path: p("shared.txt") }),
					{
						headers: { "content-type": "application/octet-stream" },
						body: "from files",
					},
				);
				expect(put.status).toBe(200);
				const r = await run({ command: "cat shared.txt" });
				expect((r.body as Any).stdout).toBe("from files");
			});
		});

		it("ports: listening ports come from the agent", async () => {
			const r = await h.request("GET", `/v1/sandboxes/${sb.ref}/ports`);
			expect(r.status).toBe(200);
			expect((r.body as Any).listening).toEqual([
				expect.objectContaining({
					port: real.info.listeningPort,
					addresses: ["0.0.0.0"],
				}),
			]);
			expect((r.body as Any).listeningObservedAt).toEqual(expect.any(String));
		});
	},
);
