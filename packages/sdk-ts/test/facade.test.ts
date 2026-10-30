// The SDK facade against the real apps/api (in process, Postgres, FakeAgent),
// the SDK scenario of S7 §16: create(wait) → exec → run with a broken agent
// attach and a broken client stream → start + follow → files (write/read,
// a 20 MiB resumable upload, a resumed download, uploadDir/downloadDir) →
// ports → PTY echo with a reconnect → delete; exec retried after a 503 on
// its first POST starts the command once; signal aborts waitUntilReady.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type Command,
	type RunEvent,
	type Sandbox,
	Sbx,
	SbxError,
} from "../src/index.ts";
import { startTestApi, type TestApi } from "./helpers/api.ts";

const SUITE = `facade-${process.pid}`;

const sha256 = (b: Uint8Array | string) =>
	createHash("sha256").update(b).digest("hex");

/** The core id of a `cmd_...` (upper-case ULID). */
const coreCommandId = (id: string) => id.slice(4).toUpperCase();

async function until<T>(
	fn: () =>
		| Promise<T | null | undefined | false>
		| T
		| null
		| undefined
		| false,
	ms = 10_000,
	what = "condition",
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await fn();
		if (v !== undefined && v !== null && v !== false) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** A body that passes the first `n` bytes of `res`, then breaks. */
function cutAfter(res: Response, n: number): Response {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			if (sent >= n) {
				await reader.cancel();
				c.error(new TypeError("terminated (test cut)"));
				return;
			}
			const r = await reader.read();
			if (r.done) {
				c.close();
				return;
			}
			const part = r.value.subarray(0, n - sent);
			sent += part.length;
			c.enqueue(part);
		},
		cancel: () => reader.cancel(),
	});
	return new Response(body, { status: res.status, headers: res.headers });
}

/** A body that passes the first `n` bytes of `res`, then stays silent. */
function stallAfter(res: Response, n: number): Response {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			if (sent >= n) {
				await new Promise(() => {});
				return;
			}
			const r = await reader.read();
			if (r.done) {
				c.close();
				return;
			}
			const part = r.value.subarray(0, n - sent);
			sent += part.length;
			c.enqueue(part);
		},
		cancel: () => reader.cancel(),
	});
	return new Response(body, { status: res.status, headers: res.headers });
}

function isCommandsPost(req: Request) {
	return (
		req.method === "POST" && new URL(req.url).pathname.endsWith("/commands")
	);
}

function isStreamGet(req: Request) {
	return req.method === "GET" && new URL(req.url).pathname.endsWith("/stream");
}

/** Joins the output events of each stream, checking offsets are contiguous. */
function joinOutput(events: RunEvent[]) {
	const text = { stdout: "", stderr: "", pty: "" };
	const next = { stdout: 0, stderr: 0, pty: 0 };
	for (const ev of events) {
		if (ev.type === "stdout" || ev.type === "stderr" || ev.type === "pty") {
			expect(ev.offset).toBe(next[ev.type]);
			next[ev.type] = ev.nextOffset;
			text[ev.type] += ev.data;
		}
	}
	return { ...text, next };
}

describe.skipIf(skipPg())("Sbx facade against apps/api", () => {
	let db: TestDatabase;
	let api: TestApi;
	let sbx: Sbx;
	let sb: Sandbox;
	let tmp: string;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		api = await startTestApi(db);
		sbx = new Sbx({
			baseUrl: api.url,
			apiKey: api.secret,
			fetch: api.fetch,
			env: {},
		});
		tmp = await mkdtemp(join(tmpdir(), "sbx-sdk-facade-"));
	});

	afterAll(async () => {
		await api?.close();
		await db?.drop();
		if (tmp) await rm(tmp, { recursive: true, force: true });
	});

	it("create(wait) returns once the sandbox is ready (long-poll)", async () => {
		const created = sbx.sandboxes.create(
			{ labels: { suite: SUITE } },
			{ wait: true },
		);
		// The worker's part: the sandbox becomes ready while the SDK long-polls.
		const slug = await until(async () => {
			const r = await db.pool.query<{ slug: string }>(
				"SELECT slug FROM runtime.sandboxes WHERE team_id = $1 AND state = 'creating'",
				[api.env.p.teamId],
			);
			return r.rows[0]?.slug;
		});
		await new Promise((r) => setTimeout(r, 300));
		await api.markReady(slug);
		sb = await created;
		expect(sb.slug).toBe(slug);
		expect(sb.state).toBe("ready");
		expect(sb.id).toMatch(/^sb_/);
		const polls = api.requests.filter(
			(r) => r.method === "GET" && r.path.includes("waitFor=ready"),
		);
		expect(polls.length).toBeGreaterThanOrEqual(1);
		expect(polls.length).toBeLessThan(5);
	});

	it("exec collects stdout, stderr and the exit code (stream mode)", async () => {
		const r = await sb.exec("echo out; echo err >&2; exit 3", {
			env: { A: "1" },
		});
		expect(r).toMatchObject({
			stdout: "out\n",
			stderr: "err\n",
			exitCode: 3,
			stdoutTruncated: false,
			stderrTruncated: false,
		});
		expect(r.command.status).toBe("exited");
		expect(r.command.mode).toBe("stream");
		expect(r.command.envKeys).toEqual(["A"]);
	});

	it("exec keeps the last 4 MiB of a larger output and marks it truncated", async () => {
		const r = await sb.exec(
			"head -c 5000000 /dev/zero | tr '\\0' a; echo; echo end",
		);
		expect(r.exitCode).toBe(0);
		expect(r.stdoutTruncated).toBe(true);
		expect(r.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(r.stdout.length).toBeGreaterThan(4 * 1024 * 1024 - 70_000);
		expect(r.stdout.endsWith("aaa\nend\n")).toBe(true);
		expect(r.stderrTruncated).toBe(false);
	});

	it("exec after a 503 on the first POST is retried with the same key and starts once", async () => {
		const seen: Request[] = [];
		api.intercept(async (req, next) => {
			if (!isCommandsPost(req)) return null;
			seen.push(req.clone());
			// The api starts the command, the answer is lost behind a proxy 503.
			const res = await next(req);
			await res.body?.cancel();
			return new Response("<html>503 Service Unavailable</html>", {
				status: 503,
			});
		});
		const posts = () => api.requests.filter((r) => r.method === "POST");
		const before = posts().length;
		const r = await sb.exec("echo once-$((20+22))");
		expect(r.stdout).toBe("once-42\n");
		expect(r.exitCode).toBe(0);
		const command = sb.command(r.command.id);
		const mine = posts().slice(before);
		expect(mine).toHaveLength(2);
		const [a, b] = mine;
		expect(a?.headers.get("idempotency-key")).toBeTruthy();
		expect(b?.headers.get("idempotency-key")).toBe(
			a?.headers.get("idempotency-key"),
		);
		expect(seen).toHaveLength(1);
		expect(api.agent.startCount(coreCommandId(command.id))).toBe(1);
	});

	it("run reattaches after the agent attach fails and the client stream breaks", async () => {
		const { machineId } = await api.sandboxRow(sb.slug);
		// The api's attach to the agent ends with error{agent_unavailable,
		// retryable} after 20 000 bytes; the SDK must reopen /stream.
		api.agent.failNextAttach(machineId as string, 20_000, "unavailable");
		// The first reattach (GET /stream) breaks on the client side.
		api.intercept(async (req, next) =>
			isStreamGet(req) ? cutAfter(await next(req), 30_000) : null,
		);
		const line = "x".repeat(90);
		const script = `for i in $(seq 1 2000); do echo "out-$i-${line}"; done; for i in $(seq 1 300); do echo "err-$i" >&2; done; exit 7`;
		const expected = {
			stdout: Array.from(
				{ length: 2000 },
				(_, i) => `out-${i + 1}-${line}\n`,
			).join(""),
			stderr: Array.from({ length: 300 }, (_, i) => `err-${i + 1}\n`).join(""),
		};
		const streamsBefore = api.requests.filter((r) =>
			isStreamPath(r.path),
		).length;
		let command: Command | undefined;
		const events: RunEvent[] = [];
		for await (const ev of sb.run(script, {
			onStart: (c) => {
				command = c;
			},
		})) {
			events.push(ev);
		}
		const out = joinOutput(events);
		expect(sha256(out.stdout)).toBe(sha256(expected.stdout));
		expect(sha256(out.stderr)).toBe(sha256(expected.stderr));
		const exit = events.at(-1);
		expect(exit).toMatchObject({
			type: "exit",
			status: "exited",
			exitCode: 7,
			stdoutOffset: expected.stdout.length,
			stderrOffset: expected.stderr.length,
		});
		expect(command?.id).toMatch(/^cmd_/);
		expect(api.agent.startCount(coreCommandId(command?.id as string))).toBe(1);
		const reattaches =
			api.requests.filter((r) => isStreamPath(r.path)).length - streamsBefore;
		expect(reattaches).toBeGreaterThanOrEqual(2);
	});

	it("a stream with no line for the idle timeout is reopened from its offsets", async () => {
		const quick = new Sbx({
			baseUrl: api.url,
			apiKey: api.secret,
			fetch: api.fetch,
			env: {},
			streamIdleTimeoutMs: 400,
		});
		const s = await quick.sandboxes.get(sb.slug);
		// The first answer delivers a few bytes, then nothing more.
		api.intercept(async (req, next) =>
			isCommandsPost(req) ? stallAfter(await next(req), 300) : null,
		);
		const events: RunEvent[] = [];
		const started = Date.now();
		for await (const ev of s.run(
			"for i in $(seq 1 50); do echo idle-$i; done",
		)) {
			events.push(ev);
		}
		expect(joinOutput(events).stdout).toBe(
			Array.from({ length: 50 }, (_, i) => `idle-${i + 1}\n`).join(""),
		);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("breaking out of run does not kill the command", async () => {
		let command: Command | undefined;
		for await (const ev of sb.run("echo first; sleep 30", {
			onStart: (c) => {
				command = c;
			},
		})) {
			expect(ev).toMatchObject({ type: "stdout", data: "first\n" });
			break;
		}
		const c = command as Command;
		await new Promise((r) => setTimeout(r, 200));
		expect((await c.refresh()).status).toBe("running");
		const killed = await c.kill({ graceMs: 0 });
		expect(killed.id).toBe(c.id);
		expect(await c.wait()).toMatchObject({ status: "killed" });
	});

	it("start + follow from the start, from the end, output()", async () => {
		const cmd = await sb.start("for i in 1 2 3; do echo n$i; sleep 0.1; done");
		expect(cmd.id).toMatch(/^cmd_/);
		expect(cmd.data?.mode).toBe("detached");
		const events: RunEvent[] = [];
		for await (const ev of cmd.follow({ from: "start" })) events.push(ev);
		expect(joinOutput(events).stdout).toBe("n1\nn2\nn3\n");
		expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 0 });

		const tail: RunEvent[] = [];
		for await (const ev of cmd.follow({ from: "end" })) tail.push(ev);
		expect(tail).toEqual([expect.objectContaining({ type: "exit" })]);

		const part = await cmd.output("stdout", 3, 3);
		expect(new TextDecoder().decode(part.data)).toBe("n2\n");
		expect(part).toMatchObject({ offset: 3, nextOffset: 6, end: 9 });

		const b64: RunEvent<"base64">[] = [];
		for await (const ev of cmd.follow({ encoding: "base64" })) b64.push(ev);
		const first = b64[0];
		expect(first?.type).toBe("stdout");
		expect(first?.type === "stdout" && first.data).toBeInstanceOf(Uint8Array);
	});

	it("files: write, read, stat, list, mkdir, move, chmod, remove", async () => {
		const f = sb.files;
		const info = await f.writeText("notes/hi.txt", "hi there", { mode: 0o600 });
		expect(info).toMatchObject({
			name: "hi.txt",
			type: "file",
			sizeBytes: 8,
			mode: 0o600,
		});
		expect(await f.readText("notes/hi.txt")).toBe("hi there");
		const bin = randomBytes(70_000);
		await f.writeBytes("notes/bin.dat", bin);
		expect(sha256(await f.readBytes("notes/bin.dat"))).toBe(sha256(bin));
		expect((await f.stat("notes/bin.dat")).sizeBytes).toBe(70_000);
		await f.mkdir("notes/sub/deep", { parents: true });
		const names: string[] = [];
		for await (const e of f.list("notes", { limit: 1 })) names.push(e.name);
		expect(names.sort()).toEqual(["bin.dat", "hi.txt", "sub"]);
		await f.move("notes/hi.txt", "notes/sub/hi.txt");
		expect(await f.readText("notes/sub/hi.txt")).toBe("hi there");
		expect((await f.chmod("notes/sub/hi.txt", { mode: 0o644 })).mode).toBe(
			0o644,
		);
		expect(await f.remove("notes/bin.dat")).toEqual({ existed: true });
		expect(await f.remove("notes/bin.dat")).toEqual({ existed: false });
		const err = await f.readText("notes/bin.dat").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({ status: 404, code: "path_not_found" });
	});

	it("upload of 20 MiB survives a lost chunk answer; download resumes with Range", async () => {
		const data = randomBytes(20 * 1024 * 1024);
		let chunkPuts = 0;
		api.intercept(async (req, next) => {
			const p = new URL(req.url).pathname;
			if (req.method !== "PUT" || !p.includes("/files/uploads/")) return null;
			chunkPuts += 1;
			if (chunkPuts !== 2) return null;
			// The second chunk reaches the agent, its answer is lost.
			const res = await next(req);
			await res.body?.cancel();
			throw new TypeError("fetch failed (test: answer lost)");
		});
		const progress: number[] = [];
		const info = await sb.files.upload("big/blob.bin", data, {
			onProgress: (n) => progress.push(n),
		});
		expect(info.sizeBytes).toBe(data.length);
		expect(progress.at(-1)).toBe(data.length);
		const puts = api.requests.filter(
			(r) => r.method === "PUT" && r.path.includes("/files/uploads/"),
		);
		expect(puts.length).toBe(6); // 5 chunks of 4 MiB + the repeat of chunk 2
		expect(api.requests.some((r) => r.path.includes("/commit"))).toBe(true);

		// Download: the first answer breaks halfway; the rest comes with Range.
		api.intercept(async (req, next) => {
			const p = new URL(req.url).pathname;
			if (req.method !== "GET" || !p.endsWith("/files/content")) return null;
			return cutAfter(await next(req), 9 * 1024 * 1024);
		});
		const dest = join(tmp, "blob.bin");
		const got = await sb.files.download("big/blob.bin", dest);
		expect(got.sizeBytes).toBe(data.length);
		expect(sha256(await readFile(dest))).toBe(sha256(data));
		const ranged = api.requests.filter(
			(r) => r.path.includes("/files/content") && r.headers.has("range"),
		);
		expect(ranged.at(-1)?.headers.get("range")).toBe(
			`bytes=${9 * 1024 * 1024}-`,
		);
		expect(ranged.at(-1)?.headers.get("if-range")).toBeTruthy();
	});

	it("upload without transport retries resumes from the offset of HEAD", async () => {
		const data = randomBytes(9 * 1024 * 1024);
		let chunkPuts = 0;
		api.intercept(async (req, next) => {
			const p = new URL(req.url).pathname;
			if (req.method !== "PUT" || !p.includes("/files/uploads/")) return null;
			chunkPuts += 1;
			if (chunkPuts !== 2) return null;
			const res = await next(req);
			await res.body?.cancel();
			throw new TypeError("fetch failed (test: answer lost)");
		});
		const from = api.requests.length;
		const info = await sb.files.upload("big/resumed.bin", data, {
			retryBudgetMs: 0,
		});
		expect(info.sizeBytes).toBe(data.length);
		const mine = api.requests.slice(from);
		const head = mine.findIndex(
			(r) => r.method === "HEAD" && r.path.includes("/files/uploads/"),
		);
		expect(head).toBeGreaterThan(0);
		// After HEAD the upload goes on with the third chunk: chunk 2 is not sent again.
		const putsAfter = mine
			.slice(head)
			.filter((r) => r.method === "PUT")
			.map((r) => new URL(r.path, api.url).searchParams.get("offset"));
		expect(putsAfter).toEqual([String(8 * 1024 * 1024)]);
		expect(sha256(await sb.files.readBytes("big/resumed.bin"))).toBe(
			sha256(data),
		);
	});

	it("download restarts when the file changed between the break and the resume", async () => {
		const first = randomBytes(2 * 1024 * 1024);
		const second = randomBytes(3 * 1024 * 1024);
		await sb.files.writeBytes("big/changing.bin", first);
		// A client without the hooks writes the new version while the first
		// answer is cut; the resume's If-Range no longer matches.
		const plain = new Sbx({ baseUrl: api.url, apiKey: api.secret, env: {} });
		const other = await plain.sandboxes.get(sb.slug);
		api.intercept(async (req, next) => {
			const p = new URL(req.url).pathname;
			if (req.method !== "GET" || !p.endsWith("/files/content")) return null;
			const res = cutAfter(await next(req), 1024 * 1024);
			await new Promise((r) => setTimeout(r, 20)); // a later mtime
			await other.files.writeBytes("big/changing.bin", second);
			return res;
		});
		const dest = join(tmp, "changing.bin");
		const got = await sb.files.download("big/changing.bin", dest);
		expect(got.sizeBytes).toBe(second.length);
		expect(sha256(await readFile(dest))).toBe(sha256(second));
		const gets = api.requests.filter(
			(r) => r.method === "GET" && r.path.includes("big%2Fchanging.bin"),
		);
		expect(gets.at(-1)?.headers.get("range")).toBe(`bytes=${1024 * 1024}-`);
	});

	it("uploadDir and downloadDir move a directory tree through tar.gz", async () => {
		const src = join(tmp, "tree");
		await mkdir(join(src, "sub", "deeper"), { recursive: true });
		const blob = randomBytes(100_000);
		await writeFile(join(src, "a.txt"), "alpha\n");
		await writeFile(join(src, ".hidden"), "h\n");
		await writeFile(join(src, "sub", "b.bin"), blob);
		await writeFile(join(src, "sub", "deeper", "c.txt"), "gamma\n");
		const r = await sb.files.uploadDir(src, "proj");
		expect(r.entries).toBeGreaterThanOrEqual(4);
		expect(await sb.files.readText("proj/sub/deeper/c.txt")).toBe("gamma\n");
		const back = join(tmp, "tree-back");
		await sb.files.downloadDir("proj", back);
		expect(await readFile(join(back, "a.txt"), "utf8")).toBe("alpha\n");
		expect(await readFile(join(back, ".hidden"), "utf8")).toBe("h\n");
		expect(sha256(await readFile(join(back, "sub", "b.bin")))).toBe(
			sha256(blob),
		);
		expect(await readFile(join(back, "sub", "deeper", "c.txt"), "utf8")).toBe(
			"gamma\n",
		);
	});

	it("uploadDir with `entries` packs only those paths (and their parent directories)", async () => {
		const src = join(tmp, "listed");
		await mkdir(join(src, "a", "b"), { recursive: true });
		await mkdir(join(src, "skip"), { recursive: true });
		await writeFile(join(src, "a", "b", "kept.txt"), "kept\n");
		await writeFile(join(src, "top.txt"), "top\n");
		await writeFile(join(src, "skip", "no.txt"), "no\n");
		await writeFile(join(src, "a", "no.txt"), "no\n");
		const r = await sb.files.uploadDir(src, "listed", {
			// A name as bytes (non-UTF-8 names come from git that way).
			entries: [new TextEncoder().encode("a/b/kept.txt"), "./top.txt"],
		});
		// a, a/b, a/b/kept.txt, top.txt
		expect(r.entries).toBe(4);
		expect(await sb.files.readText("listed/a/b/kept.txt")).toBe("kept\n");
		expect(await sb.files.readText("listed/top.txt")).toBe("top\n");
		const names: string[] = [];
		for await (const f of sb.files.list("listed", { depth: 3 })) {
			names.push(f.path.slice(f.path.indexOf("listed/") + 7));
		}
		expect(names.sort()).toEqual(["a", "a/b", "a/b/kept.txt", "top.txt"]);
		// No entries: only the directory.
		const none = await sb.files.uploadDir(src, "listed-empty", { entries: [] });
		expect(none.entries).toBe(0);
		expect((await sb.files.stat("listed-empty")).type).toBe("dir");
	});

	it("ports: host with a token, list, rotate, unhost", async () => {
		const p = await sb.ports.host(8000, { access: "token" });
		expect(p).toMatchObject({ port: 8000, access: "token" });
		expect(p.token).toMatch(/^sbxp_/);
		expect(p.urlWithToken).toContain(p.token as string);
		const list = await sb.ports.list();
		expect(list.hosted.map((h) => h.port)).toEqual([8000]);
		const rotated = await sb.ports.rotateToken(8000);
		expect(rotated.token).not.toBe(p.token);
		await sb.ports.unhost(8000);
		expect((await sb.ports.list()).hosted).toEqual([]);
	});

	it("pty: a refused handshake (403 before the upgrade) ends at once", async () => {
		const pty = await sb.pty({ command: "sleep 30" });
		const readOnly = new Sbx({
			baseUrl: api.url,
			apiKey: await api.key(["sandboxes:read"]),
			env: {},
		});
		const view = await readOnly.sandboxes.get(sb.slug);
		const started = Date.now();
		const err = await view.connectPty(pty.command.id).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({ status: 403, code: "forbidden" });
		expect(Date.now() - started).toBeLessThan(2000);
		await pty.kill({ graceMs: 0 });
		pty.close();
	});

	it("pty: echo, a dropped socket reconnects by offset without loss, exit", async () => {
		const pty = await sb.pty({
			cols: 100,
			rows: 30,
			command: 'while read l; do echo "got $l"; [ "$l" = bye ] && exit 0; done',
		});
		let out = "";
		const dec = new TextDecoder();
		pty.onData((b) => {
			out += dec.decode(b, { stream: true });
		});
		pty.write("hello\n");
		await until(() => out.includes("got hello\n"), 5000, "first echo");
		expect(pty.offset).toBe("got hello\n".length);
		// The server drops the socket; the SDK reconnects from its offset.
		const before = api.sockets();
		expect(before).toHaveLength(1);
		for (const ws of before) ws.terminate();
		await until(
			() =>
				api.sockets().length === 1 &&
				!before.includes(api.sockets()[0] as never),
			5000,
			"reconnect",
		);
		pty.resize(120, 40);
		pty.write("bye\n");
		const exit = await pty.exited;
		expect(exit).toMatchObject({ type: "exit", exitCode: 0 });
		expect(out).toBe("got hello\ngot bye\n");
		expect(exit.ptyOffset).toBe(out.length);
		expect(api.agent.ptySizes(coreCommandId(pty.command.id))).toContainEqual({
			cols: 120,
			rows: 40,
		});
	});

	it("signal aborts waitUntilReady at once", async () => {
		const other = await sbx.sandboxes.create({ labels: { suite: SUITE } });
		expect(other.state).toBe("creating");
		const ac = new AbortController();
		const started = Date.now();
		const p = other
			.waitUntilReady({ signal: ac.signal })
			.catch((e: unknown) => e);
		setTimeout(() => ac.abort(), 300);
		expect(await p).toMatchObject({ name: "AbortError" });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("sandboxes.list iterates every page; get by slug", async () => {
		const found: string[] = [];
		for await (const s of sbx.sandboxes.list({
			label: { suite: SUITE },
			limit: 1,
		})) {
			found.push(s.slug);
		}
		expect(found).toHaveLength(2);
		expect(found).toContain(sb.slug);
		const pages = api.requests.filter(
			(r) => r.method === "GET" && r.path.startsWith("/v1/sandboxes?"),
		);
		expect(pages.length).toBeGreaterThanOrEqual(2);
		expect((await sbx.sandboxes.get(sb.slug)).id).toBe(sb.id);
		expect(await sbx.me()).toBeTruthy();
		expect((await sbx.templates()).length).toBeGreaterThan(0);
	});

	it("snapshots.create({wait}) throws the error of a failed operation", async () => {
		const p = sbx.snapshots
			.create({ sandbox: sb.slug, name: `snap-${process.pid}` }, { wait: true })
			.catch((e: unknown) => e);
		const { id } = await api.sandboxRow(sb.slug);
		const opId = await until(async () => {
			const r = await db.pool.query<{ id: string }>(
				"SELECT id FROM runtime.operations WHERE sandbox_id = $1 AND kind = 'save_snapshot'",
				[id],
			);
			return r.rows[0]?.id;
		});
		await new Promise((r) => setTimeout(r, 300));
		await db.pool.query(
			`UPDATE runtime.operations
			 SET state = 'failed', error_code = 'snapshot_failed', error_message = 'disk full',
			     retryable = false, started_at = now(), finished_at = now()
			 WHERE id = $1`,
			[opId],
		);
		const err = await p;
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({
			code: "snapshot_failed",
			message: "disk full",
			retryable: false,
			details: { kind: "save_snapshot", state: "failed" },
		});
	});

	it("delete sends Sbx-Confirm-Delete with the sandbox id", async () => {
		const op = await sb.delete();
		expect(op?.kind).toBe("delete");
		expect(sb.state).toBe("deleting");
		const del = api.requests.filter((r) => r.method === "DELETE").at(-1);
		expect(del?.headers.get("sbx-confirm-delete")).toBe(sb.id);
	});
});

function isStreamPath(path: string) {
	return /\/commands\/[^/]+\/stream/.test(path);
}
