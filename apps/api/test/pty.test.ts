// PTY over WebSocket (S7 §10): POST /ptys (Idempotency-Key, process.pty),
// resize, and GET /ptys/{cmd}/connect with the subprotocol sbx.pty.v1 over
// a real HTTP server (createApiServer) and the `ws` client: echo, input
// batching with session/seq, resize, reconnect by offset without loss or
// duplicates, scrollback, refusals before the upgrade (HTTP with the error
// envelope), close codes after it (4401/4404/4409/4503, 1000, 1012),
// backpressure and ping.
import type { AddressInfo } from "node:net";
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	type AgentApi,
	type AgentSendInputRequest,
	createApiServer,
	IdentityListener,
	PTY_SUBPROTOCOL,
	StreamRegistry,
} from "../src/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
	sleep,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

interface Closed {
	code: number;
	reason: string;
}

interface Client {
	ws: WebSocket;
	/** Parsed text (control) frames. */
	texts: Any[];
	/** Binary (output) frames. */
	chunks: Buffer[];
	pings: number;
	bytes(): Buffer;
	opened: Promise<void>;
	closed: Promise<Closed>;
	/** The HTTP answer of a refused upgrade. */
	refused: Promise<{ status: number; headers: Any; body: Any }>;
	send(data: string | Buffer): void;
}

async function until<T>(
	fn: () => T | undefined | null | false,
	ms = 5000,
	what = "condition",
): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = fn();
		if (v !== undefined && v !== null && v !== false) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/** A listener app on a real HTTP server with WebSocket upgrades. */
async function serve(app: Harness["app"]): Promise<{
	base: string;
	close(): Promise<void>;
}> {
	const { server } = createApiServer(app);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		base: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

describe.skipIf(skipPg())("PTY over WebSocket", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let events: IdentityListener;
	let h: Harness;
	let sb: ReadySandbox;
	let base: string;
	let closeServer: () => Promise<void>;
	const inputs: AgentSendInputRequest[] = [];
	/**
	 * Faults of the next sendInput calls: the connection resets before the
	 * call reaches the agent, or after it applied the input.
	 */
	const inputFaults: ("before" | "after")[] = [];
	const reset = () =>
		Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
	/** Data bytes the agent attach delivered, by command (core id). */
	const attached = new Map<string, number>();
	const clients: Client[] = [];

	/**
	 * The FakeAgent with sendInput and the attach progress recorded (methods
	 * are bound to the target: its private fields stay reachable).
	 */
	function spied(a: AgentApi): AgentApi {
		return new Proxy(a, {
			get(t, p) {
				if (p === "attach") {
					return async function* (
						m: string,
						req: Parameters<AgentApi["attach"]>[1],
						signal: AbortSignal,
					) {
						for await (const ev of t.attach(m, req, signal)) {
							if (ev.type === "data") {
								const n = attached.get(req.commandId) ?? 0;
								attached.set(req.commandId, n + ev.data.length);
							}
							yield ev;
						}
					};
				}
				if (p === "sendInput") {
					return async (m: string, req: AgentSendInputRequest) => {
						inputs.push({ ...req, data: Buffer.from(req.data) });
						const fault = inputFaults.shift();
						if (fault === "before") throw reset();
						const r = await t.sendInput(m, req);
						if (fault === "after") throw reset();
						return r;
					};
				}
				const v = Reflect.get(t, p, t);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
	}

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		events = IdentityListener.connect(db.url, { reconnectDelayMs: 50 });
		events.start();
		await events.whenReady();
		h = w.harness({
			deps: {
				identityEvents: events,
				agent: spied(w.agent),
				ptyTimings: {
					pingMs: 100,
					inputCoalesceMs: 20,
					highWaterBytes: 64 * 1024,
					inputRetryMs: 2000,
				},
			},
		});
		sb = await readySandbox(w);
		const srv = await serve(h.app);
		base = srv.base;
		closeServer = srv.close;
	});
	afterEach(() => {
		for (const c of clients.splice(0)) c.ws.terminate();
	});
	afterAll(async () => {
		await closeServer?.();
		await events?.close();
		await w?.close();
		await db?.drop();
	});

	const ptys = (s = sb) => `/v1/sandboxes/${s.ref}/ptys`;
	// Echoes lines and exits after "bye" (the fake PTY has no line
	// discipline: ^D is just a byte there).
	const ECHO = `while IFS= read -r l; do printf '%s\\n' "$l"; [ "$l" = bye ] && exit 0; done`;

	function connect(
		path: string,
		o: {
			protocols?: string[];
			headers?: Record<string, string>;
			bearer?: string | null;
			autoPong?: boolean;
			base?: string;
		} = {},
	): Client {
		const headers: Record<string, string> = { ...o.headers };
		const bearer = o.bearer === undefined ? w.secret : o.bearer;
		if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
		const ws = new WebSocket(
			`${o.base ?? base}${path}`,
			o.protocols ?? [PTY_SUBPROTOCOL],
			{
				headers,
				autoPong: o.autoPong ?? true,
			},
		);
		const c: Client = {
			ws,
			texts: [],
			chunks: [],
			pings: 0,
			bytes: () => Buffer.concat(c.chunks),
			opened: new Promise((resolve, reject) => {
				ws.once("open", () => resolve());
				ws.once("error", reject);
			}),
			closed: new Promise((resolve) => {
				ws.once("close", (code, reason) =>
					resolve({ code, reason: reason.toString() }),
				);
			}),
			refused: new Promise((resolve) => {
				ws.once("unexpected-response", (req, res) => {
					let text = "";
					res.on("data", (d: Buffer) => {
						text += d.toString();
					});
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: text === "" ? null : JSON.parse(text),
						});
						req.destroy();
					});
				});
			}),
			send: (data) => ws.send(data),
		};
		c.opened.catch(() => {});
		ws.on("error", () => {});
		ws.on("ping", () => {
			c.pings++;
		});
		ws.on("message", (data, isBinary) => {
			const b = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
			if (isBinary) c.chunks.push(b);
			else c.texts.push(JSON.parse(b.toString("utf8")));
		});
		clients.push(c);
		return c;
	}

	async function createPty(
		json: Record<string, unknown> = {},
		o: { key?: string; s?: ReadySandbox } = {},
	) {
		return h.request("POST", ptys(o.s), {
			json: { cols: 120, rows: 32, ...json },
			...(o.key === undefined ? {} : { headers: { "idempotency-key": o.key } }),
		});
	}

	async function pty(json: Record<string, unknown>, s = sb): Promise<string> {
		const r = await createPty(json, { s });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		return (r.body as Any).id;
	}

	const connectPath = (id: string, query = "", s = sb) =>
		`${ptys(s)}/${id}/connect${query}`;

	it("POST /ptys: 201 Command mode pty with the size of the spec; a key repeat is the same command", async () => {
		const r = await createPty(
			{ command: "cat", term: "vt100", env: { A: "1" } },
			{ key: "pty-key-1" },
		);
		expect(r.status).toBe(201);
		const body = r.body as Any;
		expect(body).toMatchObject({
			mode: "pty",
			command: "cat",
			status: "running",
			envKeys: ["A"],
		});
		expect(body.streams).toHaveProperty("pty");
		const raw = body.id.slice(4).toUpperCase();
		expect(w.agent.ptySizes(raw)).toEqual([{ cols: 120, rows: 32 }]);

		const again = await createPty(
			{ command: "cat", term: "vt100", env: { A: "1" } },
			{ key: "pty-key-1" },
		);
		expect(again.status).toBe(200);
		expect(again.headers.get("idempotency-replayed")).toBe("true");
		expect((again.body as Any).id).toBe(body.id);
		expect(w.agent.startCount(raw)).toBe(1);

		const other = await createPty({ command: "cat" }, { key: "pty-key-1" });
		expect(other.status).toBe(409);
		expect((other.body as Any).error.code).toBe("idempotency_key_reused");
		// The same key on POST /commands with a body of the same shape is another request.
		const cmd = await h.request("POST", sb.commands, {
			json: { command: "cat", mode: "detached" },
			headers: { "idempotency-key": "pty-key-2" },
		});
		expect(cmd.status).toBe(201);
		const asPty = await h.request("POST", ptys(), {
			json: { command: "cat", mode: undefined },
			headers: { "idempotency-key": "pty-key-2" },
		});
		expect(asPty.status).toBe(409);
		await h.request("POST", `${sb.commands}/${body.id}/kill`, {
			json: { graceMs: 0 },
		});
		await h.request("POST", `${sb.commands}/${(cmd.body as Any).id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("POST /ptys: validation, process.pty capability, scope", async () => {
		for (const json of [
			{ cols: 0 },
			{ rows: 1001 },
			{ term: "bad term" },
			{ command: "" },
			{ mode: "pty" },
			{ stdin: true },
		]) {
			const r = await createPty(json);
			expect(r.status, JSON.stringify(json)).toBe(400);
			expect((r.body as Any).error.code).toBe("validation");
		}
		const m = w.agent.machine(sb.machineId);
		const caps = m.capabilities;
		m.capabilities = ["process.v1", "process.stdin"];
		try {
			const r = await createPty({ command: "cat" });
			expect(r.status).toBe(409);
			expect((r.body as Any).error).toMatchObject({
				code: "agent_outdated",
				details: { capability: "process.pty" },
			});
		} finally {
			m.capabilities = caps;
		}
		const k = await w.key(["commands:read"]);
		const r = await h.request("POST", ptys(), {
			json: { command: "cat" },
			headers: { authorization: `Bearer ${k.secret}` },
		});
		expect(r.status).toBe(403);
	});

	it("echo: attached first, input batched into one Process/SendInput, seq in order, exit then 1000", async () => {
		const id = await pty({ command: ECHO });
		const c = connect(connectPath(id));
		await c.opened;
		expect(c.ws.protocol).toBe(PTY_SUBPROTOCOL);
		await until(() => c.texts.length > 0, 5000, "attached");
		expect(c.texts[0]).toEqual({ type: "attached", offset: 0 });

		const before = inputs.length;
		// Three frames a few ms apart, inside the coalescing window (20 ms here).
		c.send(Buffer.from("he"));
		await sleep(4);
		c.send(Buffer.from("ll"));
		await sleep(4);
		c.send(Buffer.from("o\n"));
		await until(() => c.bytes().toString() === "hello\n", 5000, "echo");
		const mine = inputs.slice(before);
		expect(mine).toHaveLength(1);
		expect(Buffer.from(mine[0]?.data ?? []).toString()).toBe("hello\n");
		expect(mine[0]?.seq).toBe(1);

		c.send(Buffer.from("again\n"));
		await until(
			() => c.bytes().toString() === "hello\nagain\n",
			5000,
			"echo 2",
		);
		const more = inputs.slice(before);
		expect(more.map((i) => i.seq)).toEqual([1, 2]);
		expect(more[1]?.inputSessionId).toBe(more[0]?.inputSessionId);

		c.send(Buffer.from("bye\n"));
		const closed = await c.closed;
		expect(closed.code).toBe(1000);
		expect(c.bytes().toString()).toBe("hello\nagain\nbye\n");
		expect(c.texts.at(-1)).toMatchObject({
			type: "exit",
			status: "exited",
			exitCode: 0,
			ptyOffset: 16,
		});
	});

	it("a new connection is a new input session; command null is the login shell", async () => {
		const id = await pty({ command: null });
		const a = connect(connectPath(id));
		await until(() => a.texts.length > 0);
		const before = inputs.length;
		a.send(Buffer.from("echo hi-$((40+2))\n"));
		await until(() => a.bytes().toString().includes("hi-42"), 5000, "shell");
		a.ws.close();
		await a.closed;
		const b = connect(connectPath(id, `?offset=${a.bytes().length}`));
		await until(() => b.texts.length > 0);
		b.send(Buffer.from("exit\n"));
		expect((await b.closed).code).toBe(1000);
		const mine = inputs
			.slice(before)
			.filter((i) => i.commandId === id.slice(4).toUpperCase());
		expect(mine).toHaveLength(2);
		expect(mine[0]?.inputSessionId).not.toBe(mine[1]?.inputSessionId);
		expect(mine.map((i) => i.seq)).toEqual([1, 1]);
	});

	it("input whose answer is lost is repeated with the same seq and applied once; a lasting outage closes 4503", async () => {
		const id = await pty({ command: ECHO });
		const c = connect(connectPath(id));
		await until(() => c.texts.length > 0);
		const before = inputs.length;
		inputFaults.push("after", "before");
		c.send(Buffer.from("once\n"));
		await until(() => c.bytes().toString() === "once\n", 5000, "echo");
		await sleep(200);
		expect(c.bytes().toString()).toBe("once\n");
		const mine = inputs.slice(before);
		expect(mine.map((i) => i.seq)).toEqual([1, 1, 1]);

		// Unanswered past inputRetryMs (2 s here): error frame, close 4503.
		inputFaults.push(...Array<"before">(100).fill("before"));
		try {
			c.send(Buffer.from("lost\n"));
			const closed = await c.closed;
			expect(closed.code).toBe(4503);
			expect(c.texts.at(-1)).toMatchObject({
				type: "error",
				code: "agent_unavailable",
				retryable: true,
			});
		} finally {
			inputFaults.length = 0;
		}
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("resize: the control frame and POST .../resize reach Process/Update", async () => {
		const id = await pty({ command: ECHO });
		const raw = id.slice(4).toUpperCase();
		const c = connect(connectPath(id));
		await until(() => c.texts.length > 0);
		c.send(JSON.stringify({ type: "resize", cols: 100, rows: 40 }));
		await until(
			() => w.agent.ptySizes(raw).length === 2,
			5000,
			"resize over the socket",
		);
		const r = await h.request("POST", `${ptys()}/${id}/resize`, {
			json: { cols: 90, rows: 30 },
		});
		expect(r.status).toBe(204);
		expect(w.agent.ptySizes(raw)).toEqual([
			{ cols: 120, rows: 32 },
			{ cols: 100, rows: 40 },
			{ cols: 90, rows: 30 },
		]);
		// An unknown control frame is ignored, the connection stays open.
		c.send(JSON.stringify({ type: "future-thing" }));
		c.send(Buffer.from("x\n"));
		await until(() => c.bytes().toString() === "x\n", 5000, "x");

		const bad = await h.request("POST", `${ptys()}/${id}/resize`, {
			json: { cols: 0, rows: 30 },
		});
		expect(bad.status).toBe(400);
		c.send(Buffer.from("bye\n"));
		expect((await c.closed).code).toBe(1000);
		const gone = await h.request("POST", `${ptys()}/${id}/resize`, {
			json: { cols: 80, rows: 24 },
		});
		expect(gone.status).toBe(409);
		expect((gone.body as Any).error.code).toBe("command_exited");

		// Not a PTY: 404.
		const cmd = await h.request("POST", sb.commands, {
			json: { command: "true", mode: "detached" },
		});
		const nr = await h.request(
			"POST",
			`${ptys()}/${(cmd.body as Any).id}/resize`,
			{ json: { cols: 80, rows: 24 } },
		);
		expect(nr.status).toBe(404);
	});

	it("a malformed control frame closes with 1008 after an error frame", async () => {
		const id = await pty({ command: "cat" });
		const c = connect(connectPath(id));
		await until(() => c.texts.length > 0);
		c.send(JSON.stringify({ type: "resize", cols: "wide" }));
		expect((await c.closed).code).toBe(1008);
		expect(c.texts.at(-1)).toMatchObject({
			type: "error",
			code: "validation",
			retryable: false,
		});
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("a dropped socket and a reconnect with the received offset: no loss, no duplicates", async () => {
		const n = 400;
		const id = await pty({
			command: `for i in $(seq 1 ${n}); do echo line-$i; sleep 0.002; done`,
		});
		const expected = Array.from(
			{ length: n },
			(_, i) => `line-${i + 1}\n`,
		).join("");
		const got: Buffer[] = [];
		let offset = 0;
		let last: Any = null;
		for (let round = 0; round < 50 && last?.type !== "exit"; round++) {
			const c = connect(connectPath(id, `?offset=${offset}`));
			await until(() => c.texts.length > 0, 5000, "attached");
			expect(c.texts[0]).toEqual({ type: "attached", offset });
			if (round < 3) {
				await until(() => c.bytes().length > 0, 5000, "some output");
				c.ws.terminate();
				await c.closed;
			} else {
				const closed = await c.closed;
				expect(closed.code).toBe(1000);
			}
			got.push(c.bytes());
			offset += c.bytes().length;
			last = c.texts.at(-1);
		}
		expect(Buffer.concat(got).toString()).toBe(expected);
		expect(last).toMatchObject({ type: "exit", ptyOffset: expected.length });

		// Scrollback after the end: tailBytes.
		const t = connect(connectPath(id, "?tailBytes=10"));
		expect((await t.closed).code).toBe(1000);
		expect(t.texts[0]).toEqual({
			type: "attached",
			offset: expected.length - 10,
		});
		expect(t.bytes().toString()).toBe(expected.slice(-10));
	});

	it("before the upgrade: no subprotocol 400, wrong one 400, no bearer 401, no scope 403, plain GET 426 — all with the error envelope", async () => {
		const id = await pty({ command: "cat" });
		const none = connect(connectPath(id), { protocols: [] });
		const r1 = await none.refused;
		expect(r1.status).toBe(400);
		expect(r1.body.error).toMatchObject({ code: "validation" });
		expect(r1.headers["request-id"]).toMatch(/^req_/);

		const wrong = connect(connectPath(id), { protocols: ["sbx.pty.v0"] });
		expect((await wrong.refused).status).toBe(400);

		const anon = connect(connectPath(id), { bearer: null });
		const r3 = await anon.refused;
		expect(r3.status).toBe(401);
		expect(r3.body.error.code).toBe("unauthorized");

		const k = await w.key(["commands:read"]);
		const weak = connect(connectPath(id), { bearer: k.secret });
		const r4 = await weak.refused;
		expect(r4.status).toBe(403);
		expect(r4.body.error.code).toBe("forbidden");

		const plain = await h.request("GET", connectPath(id));
		expect(plain.status).toBe(426);
		expect((plain.body as Any).error.code).toBe("upgrade_required");
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("proxied: a foreign Origin is refused with 403 before the upgrade; the dashboard origin with ?team= connects", async () => {
		const id = await pty({ command: "cat" });
		const { h: ph, headers } = w.session();
		const srv = await serve(ph.app);
		try {
			const open = (origin: string, query = "") =>
				connect(connectPath(id, query), {
					base: srv.base,
					bearer: null,
					headers: { ...headers, origin },
				});
			const evil = open("https://evil.example");
			const r = await evil.refused;
			expect(r.status).toBe(403);
			expect(r.body.error.code).toBe("origin_forbidden");

			const good = open(
				headers.origin as string,
				`?team=${encodeUuid("team", w.teamId)}`,
			);
			await until(() => good.texts.length > 0, 5000, "attached");
			expect(good.texts[0]).toEqual({ type: "attached", offset: 0 });
		} finally {
			for (const c of clients.splice(0)) c.ws.terminate();
			await srv.close();
			await h.request("POST", `${sb.commands}/${id}/kill`, {
				json: { graceMs: 0 },
			});
		}
	});

	it("after the upgrade: another sandbox's or an unknown command → 4404, not a PTY → 4404, sandbox not ready → 4409", async () => {
		const other = await readySandbox(w);
		const id = await pty({ command: "cat" });
		for (const path of [
			connectPath(id, "", other),
			connectPath("cmd_01jbx2v7d3m6c8q9w0e4r5t6y7"),
			connectPath("nonsense"),
		]) {
			const c = connect(path);
			const closed = await c.closed;
			expect(closed.code, path).toBe(4404);
			expect(c.texts.at(-1)).toMatchObject({
				type: "error",
				code: "not_found",
				retryable: false,
			});
			expect(c.texts.at(-1).requestId).toMatch(/^req_/);
		}
		const cmd = await h.request("POST", sb.commands, {
			json: { command: "sleep 5", mode: "detached" },
		});
		const notPty = connect(connectPath((cmd.body as Any).id));
		expect((await notPty.closed).code).toBe(4404);

		const stopped = await readySandbox(w);
		const sid = await pty({ command: "cat" }, stopped);
		await w.markState(stopped.sandboxId, "stopped");
		const c = connect(connectPath(sid, "", stopped));
		expect((await c.closed).code).toBe(4409);
		expect(c.texts.at(-1)).toMatchObject({
			type: "error",
			code: "sandbox_not_ready",
		});
		for (const k of [id, (cmd.body as Any).id]) {
			await h.request("POST", `${sb.commands}/${k}/kill`, {
				json: { graceMs: 0 },
			});
		}
	});

	it("a key revoked while connected: close 4401 within a second after an error frame", async () => {
		const k = await w.key(["commands:exec"]);
		const id = await pty({ command: "cat" });
		const c = connect(connectPath(id), { bearer: k.secret });
		await until(() => c.texts.length > 0);
		const t0 = Date.now();
		await w.identity.revokeApiKey(k.id, {});
		const closed = await c.closed;
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(closed.code).toBe(4401);
		expect(c.texts.at(-1)).toMatchObject({
			type: "error",
			code: "unauthorized",
			retryable: false,
		});
		await until(() => h.deps.streams.size === 0, 2000, "unregistered");
		const again = connect(connectPath(id), { bearer: k.secret });
		expect((await again.refused).status).toBe(401);
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("the agent gone: close 4503 after a retryable agent_unavailable frame", async () => {
		const s = await readySandbox(w);
		const id = await pty({ command: "cat" }, s);
		const c = connect(connectPath(id, "", s));
		await until(() => c.texts.length > 0);
		w.agent.setUnavailable(s.machineId, true);
		try {
			const closed = await c.closed;
			expect(closed.code).toBe(4503);
			expect(c.texts.at(-1)).toMatchObject({
				type: "error",
				code: "agent_unavailable",
				retryable: true,
				offset: 0,
			});
		} finally {
			w.agent.setUnavailable(s.machineId, false);
		}
		await h.request("POST", `${s.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("backpressure: a client that does not read stops the agent attach; all bytes arrive once it reads", async () => {
		const total = 24 * 1024 * 1024;
		const id = await pty({ command: `head -c ${total} /dev/zero` });
		// Default ping (15 s): a paused client would miss short pings.
		const srv = await serve(
			w.harness({
				deps: {
					identityEvents: events,
					agent: spied(w.agent),
					ptyTimings: {
						pingMs: 15_000,
						inputCoalesceMs: 5,
						highWaterBytes: 64 * 1024,
						inputRetryMs: 2000,
					},
				},
			}).app,
		);
		const c = connect(connectPath(id), { base: srv.base });
		await c.opened;
		// Stop reading the TCP socket before anything arrives: the kernel
		// buffers fill, then the server's ws buffer.
		const sock = (c.ws as Any)._socket;
		sock.pause();
		await sleep(1000);
		const r = await h.request("GET", `${sb.commands}/${id}`);
		expect((r.body as Any).streams.pty.sizeBytes).toBe(total);
		// What the server pulled from the agent is bounded by the socket
		// buffers, not the whole output.
		const pulled = attachProgress(id);
		expect(pulled).toBeLessThan(total / 2);
		sock.resume();
		const closed = await c.closed;
		expect(closed.code).toBe(1000);
		expect(c.bytes().length).toBe(total);
		await srv.close();
	});

	it("ping every pingMs; a peer that never answers is dropped", async () => {
		const id = await pty({ command: "cat" });
		const c = connect(connectPath(id));
		await until(() => c.texts.length > 0);
		await until(() => c.pings >= 2, 2000, "pings");
		const mute = connect(connectPath(id), { autoPong: false });
		await until(() => mute.texts.length > 0);
		const closed = await mute.closed;
		expect(closed.code).toBe(1006);
		await h.request("POST", `${sb.commands}/${id}/kill`, {
			json: { graceMs: 0 },
		});
	});

	it("shutdown (closeAll): a reconnect frame with the offset, then close 1012", async () => {
		const reg = new StreamRegistry({
			identity: w.identity,
			events,
			maxPerPrincipal: 1,
		});
		const srv = await serve(w.harness({ deps: { streams: reg } }).app);
		const id = await pty({ command: ECHO });
		try {
			const a = connect(connectPath(id), { base: srv.base });
			await until(() => a.texts.length > 0);
			a.send(Buffer.from("abc\n"));
			await until(() => a.bytes().length === 4, 5000, "echo");
			// One connection per principal here: the second is 429 before the upgrade.
			const b = connect(connectPath(id), { base: srv.base });
			const r = await b.refused;
			expect(r.status).toBe(429);
			expect(r.body.error.code).toBe("rate_limited");

			await reg.closeAll("server_shutdown", 5000);
			expect((await a.closed).code).toBe(1012);
			expect(a.texts.at(-1)).toEqual({
				type: "reconnect",
				offset: 4,
				reason: "server_shutdown",
			});
		} finally {
			for (const c of clients.splice(0)) c.ws.terminate();
			await srv.close();
			await h.request("POST", `${sb.commands}/${id}/kill`, {
				json: { graceMs: 0 },
			});
		}
	});

	function attachProgress(id: string): number {
		return attached.get(id.slice(4).toUpperCase()) ?? 0;
	}
});
