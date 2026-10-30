// SIGTERM of an api instance (S7 §9.7 item 3, Review Focus 5) over real
// listeners: an open NDJSON stream ends with `reconnect {reason:
// server_shutdown}`, a PTY gets the control frame `reconnect` and close
// 1012, a sync command in flight gets 503 server_shutting_down (retryable
// only with an Idempotency-Key; without one `details {commandId, outcome:
// "running"}`); meanwhile /readyz is 503 and new requests are 503; close()
// takes at most 10 s even when a stream or a connection hangs.
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	IdentityListener,
	PTY_SUBPROTOCOL,
	type RunningApi,
	SHUTDOWN_GRACE_MS,
	startApi,
} from "../src/index.ts";
import { makeTestDeps, testSettings } from "../src/testing/index.ts";
import {
	type Any,
	type ReadySandbox,
	readySandbox,
	sleep,
} from "./helpers/commands.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const ECHO = `while IFS= read -r l; do printf '%s\\n' "$l"; [ "$l" = bye ] && exit 0; done`;

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

/** NDJSON frames of a streaming response, read as they arrive. */
function ndjson(res: Response) {
	const frames: Any[] = [];
	let ended = false;
	const done = (async () => {
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		let buf = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
					const line = buf.slice(0, i);
					buf = buf.slice(i + 1);
					if (line.trim() !== "") frames.push(JSON.parse(line));
				}
			}
		} finally {
			ended = true;
		}
	})();
	return { frames, done, ended: () => ended };
}

/** A raw keep-alive HTTP/1.1 connection; `request` returns the head and body. */
function keepAlive(port: number) {
	const sock = connect(port, "127.0.0.1");
	sock.on("error", () => {});
	const closed = new Promise<void>((r) => sock.once("close", () => r()));
	let buf = "";
	let waiter: (() => void) | null = null;
	sock.on("data", (d: Buffer) => {
		buf += d.toString("latin1");
		waiter?.();
	});
	/** A whole response in `buf` (Content-Length framing), else null. */
	const take = (): string | null => {
		const end = buf.indexOf("\r\n\r\n");
		if (end < 0) return null;
		const len = Number(/\r\ncontent-length: (\d+)/i.exec(buf)?.[1] ?? 0);
		if (buf.length < end + 4 + len) return null;
		const res = buf.slice(0, end + 4 + len);
		buf = buf.slice(end + 4 + len);
		return res;
	};
	return {
		closed,
		async request(path: string): Promise<string> {
			sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
			for (;;) {
				const res = take();
				if (res !== null) return res;
				await new Promise<void>((r) => {
					waiter = r;
				});
			}
		},
	};
}

describe.skipIf(skipPg())("api shutdown (SIGTERM)", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let events: IdentityListener;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		events = IdentityListener.connect(db.url, { reconnectDelayMs: 50 });
		events.start();
		await events.whenReady();
	});
	afterAll(async () => {
		await events?.close();
		await w?.close();
		await db?.drop();
	});

	async function start(graceMs?: number): Promise<RunningApi> {
		const settings = testSettings({
			SBX_API_RATE_BURST: "100000",
			SBX_API_RATE_STARTS_PER_MIN: "100000",
			SBX_API_PUBLIC_PORT: "0",
			SBX_API_PROXIED_PORT: "0",
			SBX_API_INTERNAL_PORT: "0",
			SBX_API_METRICS_PORT: "0",
		});
		const deps = makeTestDeps(w.deps({ identityEvents: events, settings }));
		return startApi(settings, deps, {
			host: "127.0.0.1",
			...(graceMs === undefined ? {} : { graceMs }),
		});
	}

	function client(api: RunningApi) {
		const base = `http://127.0.0.1:${api.ports.public}`;
		const auth = { authorization: `Bearer ${w.secret}` };
		return {
			base,
			post: (
				path: string,
				json: unknown,
				headers: Record<string, string> = {},
			) =>
				fetch(`${base}${path}`, {
					method: "POST",
					headers: { ...auth, "content-type": "application/json", ...headers },
					body: JSON.stringify(json),
				}),
			get: (path: string) => fetch(`${base}${path}`, { headers: auth }),
		};
	}

	it("Review Focus 5: stream -> reconnect, PTY -> reconnect + 1012, sync -> 503 (retryable only with a key); exits in time", async () => {
		const api = await start();
		const c = client(api);
		const sb: ReadySandbox = await readySandbox(w);

		const streamRes = await c.post(sb.commands, {
			mode: "stream",
			command: "echo a; sleep 5",
		});
		expect(streamRes.status).toBe(200);
		const stream = ndjson(streamRes);
		await until(
			() => stream.frames.some((f) => f.type === "stdout"),
			5000,
			"stdout",
		);

		const ptyRes = await c.post(`/v1/sandboxes/${sb.ref}/ptys`, {
			command: ECHO,
			cols: 80,
			rows: 24,
		});
		expect(ptyRes.status).toBe(201);
		const ptyId = ((await ptyRes.json()) as Any).id as string;
		const ws = new WebSocket(
			`ws://127.0.0.1:${api.ports.public}/v1/sandboxes/${sb.ref}/ptys/${ptyId}/connect`,
			[PTY_SUBPROTOCOL],
			{ headers: { authorization: `Bearer ${w.secret}` } },
		);
		const texts: Any[] = [];
		let echoed = 0;
		ws.on("message", (d, binary) => {
			if (binary) echoed += (d as Buffer).length;
			else texts.push(JSON.parse(d.toString()));
		});
		const wsClosed = new Promise<number>((r) =>
			ws.once("close", (code) => r(code)),
		);
		await new Promise<void>((r, j) => {
			ws.once("open", () => r());
			ws.once("error", j);
		});
		await until(() => texts.length > 0, 5000, "attached");
		ws.send(Buffer.from("abc\n"));
		await until(() => echoed === 4, 5000, "echo");

		const keyed = c.post(
			sb.commands,
			{ command: "sleep 5" },
			{ "idempotency-key": `k-${randomUUID()}` },
		);
		const plain = c.post(sb.commands, { command: "sleep 5" });
		// The stream, the PTY and both syncs are registered, and both syncs got
		// past the agent Start (status running), so they are mid-wait.
		await until(() => api.deps.streams.size === 4, 5000, "4 open connections");
		let running = 0;
		await until(
			() => {
				void db.pool
					.query<{ n: number }>(
						"SELECT count(*)::int AS n FROM runtime.commands WHERE sandbox_id = $1 AND status = 'running'",
						[sb.sandboxId],
					)
					.then((r) => {
						running = r.rows[0]?.n ?? 0;
					});
				return running === 4;
			},
			5000,
			"4 running commands",
		);

		const t0 = Date.now();
		const closing = api.close();

		await stream.done;
		expect(stream.frames.at(-1)).toMatchObject({
			type: "reconnect",
			reason: "server_shutdown",
			stdoutOffset: 2,
			stderrOffset: 0,
		});

		expect(await wsClosed).toBe(1012);
		expect(texts.at(-1)).toEqual({
			type: "reconnect",
			offset: 4,
			reason: "server_shutdown",
		});

		const k = await keyed;
		expect(k.status).toBe(503);
		expect(((await k.json()) as Any).error).toMatchObject({
			code: "server_shutting_down",
			retryable: true,
		});
		const p = await plain;
		expect(p.status).toBe(503);
		const pe = ((await p.json()) as Any).error;
		expect(pe).toMatchObject({
			code: "server_shutting_down",
			retryable: false,
			details: { outcome: "running" },
		});
		expect(pe.details.commandId).toMatch(/^cmd_/);

		await closing;
		// Nothing hangs here: no waiting for the deadline.
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(api.deps.streams.size).toBe(0);
	});

	it("while draining: /readyz 503 and new requests 503 server_shutting_down; a hanging stream and connection do not hold the exit past 10 s", async () => {
		expect(SHUTDOWN_GRACE_MS).toBe(10_000);
		const api = await start();
		const c = client(api);
		// A stream whose writer is stuck: it never unregisters.
		api.deps.streams.register(
			{ userId: null, apiKeyId: "k-hang", teamId: w.teamId },
			() => {},
		);
		// A connection that never completes its request.
		const slow: Socket = connect(api.ports.public, "127.0.0.1");
		await new Promise((r) => slow.once("connect", r));
		slow.write("GET /v1/meta HTTP/1.1\r\nHost: x\r\n");
		const slowClosed = new Promise<void>((r) => slow.once("close", () => r()));
		slow.on("error", () => {});
		// A keep-alive connection served before the stop (a client of the load
		// balancer that reuses its socket).
		const kept = keepAlive(api.ports.public);
		expect(await kept.request("/v1/meta")).toMatch(/^HTTP\/1\.1 200/);

		const t0 = Date.now();
		const closing = api.close();

		// Its next request is refused with Connection: close and a short
		// Retry-After, and the socket is closed: the retry opens a new
		// connection, which the balancer sends to a healthy instance.
		const refused = await kept.request("/v1/meta");
		expect(refused).toMatch(/^HTTP\/1\.1 503/);
		expect(refused).toMatch(/\r\nconnection: close\r\n/i);
		expect(refused).toMatch(/\r\nretry-after: 1\r\n/i);
		expect(refused).toContain('"retryAfterSeconds":1');
		await kept.closed;
		expect(Date.now() - t0).toBeLessThan(2000);

		const ready = await fetch(`http://127.0.0.1:${api.ports.metrics}/readyz`);
		expect(ready.status).toBe(503);
		const rb = (await ready.json()) as Any;
		expect(rb.error).toMatchObject({ code: "not_ready", retryable: true });
		expect(rb.error.details.reasons).toContain("shutting_down");

		const meta = await fetch(`${c.base}/v1/meta`);
		expect(meta.status).toBe(503);
		expect(meta.headers.get("retry-after")).not.toBeNull();
		expect(meta.headers.get("request-id")).toMatch(/^req_/);
		expect(((await meta.json()) as Any).error).toMatchObject({
			code: "server_shutting_down",
			retryable: true,
		});
		const created = await c.post(`/v1/sandboxes`, {});
		expect(created.status).toBe(503);
		const internal = await fetch(
			`http://127.0.0.1:${api.ports.internal}/internal/v1/x`,
		);
		expect(internal.status).toBe(503);

		await closing;
		const took = Date.now() - t0;
		expect(took).toBeLessThanOrEqual(SHUTDOWN_GRACE_MS);
		expect(took).toBeGreaterThan(SHUTDOWN_GRACE_MS / 2);
		await slowClosed;
	}, 20_000);

	it("an idle api closes at once", async () => {
		const api = await start(SHUTDOWN_GRACE_MS);
		const r = await client(api).get("/v1/me");
		expect(r.status).toBe(200);
		const t0 = Date.now();
		await api.close();
		expect(Date.now() - t0).toBeLessThan(1000);
		// A second close is the same promise.
		await api.close();
	});
});
