// Stream chaos (S7 §16, adapted per plan decision 3: no tunnel yet). The
// SDK's run() of a long command that writes 3000 lines × 512 B to stdout and
// to stderr, while every 100-400 ms one of these happens at random:
//   - the agent attach of the api breaks (FakeAgent failNextAttach, reset or
//     unavailable);
//   - every client connection is cut in the load balancer (a TCP proxy);
//   - the current api instance stops through its SIGTERM path (close()) and a
//     new one takes over: rolling (new instance first) or with a gap.
// The run begins with a fixed prefix, so each fault takes effect at least
// once while the SDK streams (attach failure, drop, rolling restart, gap);
// the rest is random. The first answer of POST /commands is lost after the
// api started the command, so the SDK repeats the POST with the same
// Idempotency-Key.
// All instances share the Postgres database and the FakeAgent, as the pods of
// one deployment share the database and the agents. Both streams must arrive
// byte for byte, the exit code must be right, the command must start once
// and every close() must end within the shutdown grace.
//
// The RNG is seeded; SBX_CHAOS_SEED=<n> replays a run, SBX_CHAOS_LOG=1
// prints what the faults did and the timings.
import { createHash, randomInt } from "node:crypto";
import { type RunningApi, SHUTDOWN_GRACE_MS, startApi } from "@sbx/api";
import {
	FakeAgent,
	issueApiKey,
	makeTestDeps,
	testSettings,
} from "@sbx/api/testing";
import { type ServiceEnv, serviceEnv } from "@sbx/core/testing";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Command, type Sandbox, Sbx } from "../src/index.ts";
import { markSandboxReady, sandboxRow } from "./helpers/api.ts";
import { startTcpProxy, type TcpProxy } from "./helpers/tcp-proxy.ts";

const LINES = 3000;
const LINE_BYTES = 512;
const EXIT_CODE = 3;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".repeat(22);
const FILLER = LINE_BYTES - 11; // "out 00001 " + filler + "\n"

// Lines go out in batches of 100 with a pause (then a UTF-8 BOM + "€😀"
// line on stdout, so a BOM starts an agent chunk), so the command runs ~6 s and
// the chaos hits it while it still writes, not only while its buffered
// output is read back.
const SCRIPT = `a=${ALPHABET}
for ((i=1;i<=${LINES};i++)); do
  printf 'out %05d %s\\n' "$i" "\${a:i%26:${FILLER}}"
  printf 'err %05d %s\\n' "$i" "\${a:(i+13)%26:${FILLER}}" >&2
  if ((i%100==0)); then sleep 0.2; printf '\\xef\\xbb\\xbf\\xe2\\x82\\xac\\xf0\\x9f\\x98\\x80 %05d\\n' "$i"; fi
done
exit ${EXIT_CODE}`;

function expectedOutput(prefix: "out" | "err", shift: number): string {
	let s = "";
	for (let i = 1; i <= LINES; i++) {
		const n = String(i).padStart(5, "0");
		const at = (i + shift) % 26;
		s += `${prefix} ${n} ${ALPHABET.slice(at, at + FILLER)}\n`;
		// A BOM and multi-byte characters every 100 lines (stdout only):
		// kept byte for byte across reattaches.
		if (prefix === "out" && i % 100 === 0) s += `\uFEFF€😀 ${n}\n`;
	}
	return s;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The core id of a `cmd_...` (upper-case ULID). */
const coreCommandId = (id: string) => id.slice(4).toUpperCase();

/** mulberry32: a small seeded RNG in [0, 1). */
function rngOf(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(
	fn: () => boolean,
	what: string,
	ms = 15_000,
): Promise<void> {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/**
 * `res` with its NDJSON body passed through unchanged; `onShutdown` runs for
 * each `reconnect {reason: server_shutdown}` frame in it.
 */
function watchFrames(res: Response, onShutdown: () => void): Response {
	const type = res.headers.get("content-type") ?? "";
	if (res.body === null || !type.includes("ndjson")) return res;
	const dec = new TextDecoder();
	let line = "";
	const scan = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, ctrl) {
			line += dec.decode(chunk, { stream: true });
			for (let i = line.indexOf("\n"); i >= 0; i = line.indexOf("\n")) {
				const l = line.slice(0, i);
				line = line.slice(i + 1);
				if (
					l.includes('"type":"reconnect"') &&
					l.includes('"reason":"server_shutdown"')
				) {
					onShutdown();
				}
			}
			ctrl.enqueue(chunk);
		},
	});
	return new Response(res.body.pipeThrough(scan), {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

describe.skipIf(skipPg())("stream chaos across api restarts", () => {
	let db: TestDatabase;
	let env: ServiceEnv;
	let agent: FakeAgent;
	let secret: string;
	let proxy: TcpProxy;
	let current: RunningApi;

	const settings = testSettings({
		SBX_API_RATE_BURST: "100000",
		SBX_API_RATE_STARTS_PER_MIN: "100000",
		SBX_API_PUBLIC_PORT: "0",
		SBX_API_PROXIED_PORT: "0",
		SBX_API_INTERNAL_PORT: "0",
		SBX_API_METRICS_PORT: "0",
	});

	/** A new api instance on the shared database and agent (real listeners). */
	function startInstance(): Promise<RunningApi> {
		const deps = makeTestDeps({
			settings,
			pool: db.pool,
			svc: env.svc,
			config: env.config,
			agent,
			jobs: env.jobs,
		});
		return startApi(settings, deps, { host: "127.0.0.1" });
	}

	beforeAll(async () => {
		db = await createTestDatabase({ max: 30 });
		env = await serviceEnv(db.pool);
		const teamId = env.p.teamId;
		await db.pool.query(
			"INSERT INTO identity.teams (id, name) VALUES ($1, $2)",
			[teamId, `team-${teamId.slice(0, 8)}`],
		);
		agent = new FakeAgent();
		current = await startInstance();
		({ secret } = await issueApiKey(current.deps.identity, { teamId }));
		proxy = await startTcpProxy(current.ports.public);
	});

	afterAll(async () => {
		await proxy?.close();
		await current?.close();
		await agent?.close();
		await db?.drop();
	});

	it("run delivers both streams byte for byte and starts the command once", async () => {
		const given = process.env.SBX_CHAOS_SEED;
		const seed = given ? Number(given) : randomInt(2 ** 31);
		const rng = rngOf(seed);
		const trace: string[] = [];
		const t0 = Date.now();
		const note = (s: string) => trace.push(`${Date.now() - t0}ms ${s}`);
		// What the faults did, not only how often they were picked.
		const effect = {
			attachArmed: 0,
			drops: 0,
			droppedConnections: 0,
			rolling: 0,
			gap: 0,
			/** Open streams of each instance when its close() began. */
			openAtStop: [] as number[],
			/** `reconnect {reason: server_shutdown}` frames the SDK received. */
			shutdownReconnects: 0,
		};
		const closes: Promise<number>[] = [];
		const stopped: RunningApi[] = [];

		// Requests the SDK sent while the command ran (its POSTs and reattaches).
		const sent = { posts: 0, streams: 0 };
		let counting = false;
		const sbx = new Sbx({
			baseUrl: `http://127.0.0.1:${proxy.port}`,
			apiKey: secret,
			env: {},
			fetch: (async (req: Request) => {
				if (counting) {
					const path = new URL(req.url).pathname;
					if (req.method === "POST" && path.endsWith("/commands")) {
						sent.posts += 1;
					} else if (req.method === "GET" && path.endsWith("/stream")) {
						sent.streams += 1;
					}
				}
				return watchFrames(await globalThis.fetch(req), () => {
					effect.shutdownReconnects += 1;
				});
			}) as typeof fetch,
		});
		const sb: Sandbox = await sbx.sandboxes.create({
			labels: { suite: "chaos" },
		});
		await markSandboxReady(db.pool, sb.slug);
		const row = await sandboxRow(db.pool, sb.slug);
		const machineId = row.machineId;
		if (machineId === null) throw new Error("sandbox without a machine");

		/** close() of an instance, timed; never awaited by the chaos loop. */
		const stop = (api: RunningApi) => {
			stopped.push(api);
			effect.openAtStop.push(api.deps.streams.size);
			const started = Date.now();
			closes.push(api.close().then(() => Date.now() - started));
		};
		const failAttach = (after: number) => {
			const kind = rng() < 0.5 ? "reset" : "unavailable";
			agent.failNextAttach(machineId, after, kind);
			effect.attachArmed += 1;
			note(`attach fails after ${after} B (${kind})`);
		};
		const drop = () => {
			const n = proxy.drop();
			effect.drops += 1;
			effect.droppedConnections += n;
			note(`dropped ${n} connections`);
		};
		// Rolling: the new instance takes traffic before the old one stops.
		// With `streamOpen`, the old instance is stopped only while the SDK
		// streams from it: the start of the new one can take long enough under
		// load for the stream to be between reattaches.
		const rolling = async (streamOpen = false) => {
			const old = current;
			const next = await startInstance();
			if (streamOpen) {
				await until(
					() => old.deps.streams.size > 0 && proxy.size > 0,
					"an open stream on the old instance",
				);
			}
			current = next;
			proxy.target(current.ports.public);
			stop(old);
			effect.rolling += 1;
			note(`rolling restart -> :${current.ports.public}`);
		};
		// A gap: the only instance stops; until the new one is up, new
		// connections get 503 server_shutting_down or are refused.
		const gap = async () => {
			const old = current;
			stop(old);
			await sleep(50 + Math.floor(rng() * 150));
			current = await startInstance();
			proxy.target(current.ports.public);
			effect.gap += 1;
			note(`restart with a gap -> :${current.ports.public}`);
		};
		/** The SDK streams from the current instance through the proxy. */
		const streaming = () =>
			until(
				() => current.deps.streams.size > 0 && proxy.size > 0,
				"an open stream on the current instance",
			);

		counting = true;
		proxy.cutNextAnswer();
		let done = false;
		const chaos = (async () => {
			// A fixed prefix makes every fault take effect at least once, each
			// while the SDK is streaming: an attach failure (bitten on the
			// reattach the drop causes), a drop, a rolling restart and a
			// restart with a gap.
			await streaming();
			failAttach(2000 + Math.floor(rng() * 8000));
			await streaming();
			drop();
			await until(
				() => agent.attachFailures(machineId) > 0,
				"the attach failure to bite",
			);
			await rolling(true);
			await streaming();
			await gap();
			note("prefix done");
			while (!done) {
				await sleep(100 + Math.floor(rng() * 300));
				if (done) break;
				const r = rng();
				if (r < 0.35) failAttach(Math.floor(rng() * 200_000));
				else if (r < 0.7) drop();
				else if (r < 0.92) await rolling();
				else await gap();
			}
		})();
		// A failure of the prefix ends the test at once, not after the run.
		const chaosFailed = chaos.then(
			() => new Promise<never>(() => {}),
			(e: unknown) => {
				throw e;
			},
		);

		const out = { stdout: "", stderr: "" };
		const next = { stdout: 0, stderr: 0 };
		let truncated = 0;
		let exit: unknown;
		let command: Command | undefined;
		try {
			try {
				await Promise.race([
					chaosFailed,
					(async () => {
						for await (const ev of sb.run(SCRIPT, {
							onStart: (c) => {
								command = c;
							},
						})) {
							if (ev.type === "stdout" || ev.type === "stderr") {
								expect(ev.offset, `${ev.type} offset`).toBe(next[ev.type]);
								next[ev.type] = ev.nextOffset;
								out[ev.type] += ev.data;
							} else if (ev.type === "truncated") {
								truncated += 1;
							} else if (ev.type === "exit") {
								exit = ev;
							}
						}
					})(),
				]);
			} finally {
				done = true;
				await chaos.catch(() => {});
			}
			await chaos;
			const elapsed = Date.now() - t0;
			const closeMs = await Promise.all(closes);

			const bytes = LINES * LINE_BYTES;
			const expectedOut = expectedOutput("out", 0);
			// The BOM lines: 3 + 3 + 4 bytes of characters, " 00100\n".
			const outBytes = Buffer.byteLength(expectedOut);
			expect(outBytes).toBe(bytes + (LINES / 100) * 17);
			expect(truncated).toBe(0);
			expect(out.stdout.length).toBe(expectedOut.length);
			expect(out.stderr.length).toBe(bytes);
			expect(sha256(out.stdout)).toBe(sha256(expectedOut));
			expect(sha256(out.stderr)).toBe(sha256(expectedOutput("err", 13)));
			expect(exit).toMatchObject({
				type: "exit",
				status: "exited",
				exitCode: EXIT_CODE,
				stdoutOffset: outBytes,
				stderrOffset: bytes,
			});
			expect(command?.id).toMatch(/^cmd_/);
			// Started once: one launch of this id, no launch under any other id,
			// one command row in the sandbox.
			expect(agent.startCount(coreCommandId(command?.id as string))).toBe(1);
			expect(agent.totalStarts(machineId)).toBe(1);
			const rows = await db.pool.query<{ n: number }>(
				"SELECT count(*)::int AS n FROM runtime.commands WHERE sandbox_id = $1",
				[row.id],
			);
			expect(rows.rows[0]?.n).toBe(1);
			// Every stopped instance went through its graceful stop in time and
			// left no stream open.
			for (const ms of closeMs)
				expect(ms).toBeLessThanOrEqual(SHUTDOWN_GRACE_MS);
			for (const api of stopped) expect(api.deps.streams.size).toBe(0);
			// Every fault took effect: the attach failure was thrown, the proxy
			// cut live connections, the restarts stopped instances with a stream
			// open and the SDK got their reconnect frames, and the lost first
			// answer made the SDK repeat its POST.
			expect(agent.attachFailures(machineId)).toBeGreaterThan(0);
			expect(effect.droppedConnections).toBeGreaterThan(0);
			expect(effect.rolling).toBeGreaterThan(0);
			expect(effect.gap).toBeGreaterThan(0);
			expect(effect.openAtStop[0]).toBeGreaterThan(0);
			expect(effect.openAtStop[1]).toBeGreaterThan(0);
			expect(effect.shutdownReconnects).toBeGreaterThan(0);
			expect(sent.posts).toBeGreaterThanOrEqual(2);
			expect(sent.streams).toBeGreaterThanOrEqual(1);
			const status = await command?.refresh();
			expect(status).toMatchObject({ status: "exited", exitCode: EXIT_CODE });

			if (process.env.SBX_CHAOS_LOG) {
				console.log(
					JSON.stringify({
						seed,
						elapsedMs: elapsed,
						effect: {
							...effect,
							attachFailures: agent.attachFailures(machineId),
						},
						sent,
						maxCloseMs: Math.max(0, ...closeMs),
					}),
				);
			}
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			err.message = `[chaos seed ${seed}; replay with SBX_CHAOS_SEED=${seed}]\n${err.message}\nlast actions:\n${trace.slice(-25).join("\n")}`;
			throw err;
		}
	}, 90_000);
});
