// Regression for a hostile agent's header and trailer blocks (gateway fix
// "M1", libs/tunnel/gateway/proxy.go): the api's one HTTP/2 session to a
// gateway carries every machine's calls, and a Node client destroys the whole
// session on a header block it cannot take. One gateway, a hostile machine A
// and two well-behaved machines B and C, one AgentClient (the default
// transport): while B and C run long and short server streams and unary
// calls, A answers with each attack of the tunnel harness (hostile.go) over
// unary, server-stream and /files calls. B and C must see no error, the
// session must never be replaced, and A's calls must end cleanly after one
// request each. SBX_M1_LONG=1 repeats the attack set 200 times instead of 50.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import dc from "node:diagnostics_channel";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import type { Socket } from "node:net";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	onTestFailed,
} from "vitest";
import { AgentClient, classify, PgRegistry } from "../src/index.js";
import {
	type AttachResponse,
	ExitStatus,
	Process,
	Stream,
} from "./gen/sbx/testing/v1/process_pb.js";
import {
	type Harness,
	removeHarnessBuild,
	startHarness,
} from "./helpers/harness.js";
import { createTestDatabase, skipPg, type TestDatabase } from "./helpers/pg.js";

const serviceToken = "m1-service-token";
const long = process.env.SBX_M1_LONG === "1";
const repetitions = long ? 200 : 50;

/**
 * What a call to the hostile machine must end with:
 * - ok: the answer passes intact (the agent's headers or trailers fit);
 * - refused: the gateway refuses the answer before it starts (Connect
 *   internal with ErrorDetail bad_agent_response, or HTTP 502);
 * - reset: the body passes, then the gateway resets that stream on its
 *   trailers;
 * - skip: not called this way.
 */
type Outcome = "ok" | "refused" | "reset" | "skip";

interface Expect {
	unary: Outcome;
	stream: Outcome;
	/** /files/hostile/<attack> over fetch (undici takes at most 16 KiB of headers). */
	files: Outcome;
	/** Minimum header and trailer block (HTTP/2 size) the client must receive. */
	minHeaderBytes?: number;
	minTrailerBytes?: number;
}

// Over Connect only: the header blocks are larger than undici takes.
const connectOk: Expect = { unary: "ok", stream: "ok", files: "skip" };
const refused: Expect = {
	unary: "refused",
	stream: "refused",
	files: "refused",
};
// Connect unary answers end without trailers over the limit (a reset would
// make the client retry a call the agent answered); streams are reset. Over
// HTTP/1.1 the /files body has a Content-Length and arrives whole before the
// gateway drops the connection.
const trailersOver: Expect = { unary: "ok", stream: "reset", files: "ok" };
const nearLimit = 60_000;

/** Every attack of the harness (hostile.go) and its expected outcome. */
const attacks: Record<string, Expect> = {
	none: { unary: "ok", stream: "ok", files: "ok" },
	"trailer-name-140k": refused,
	"trailer-names-12x60k": refused,
	"trailer-names-33": refused,
	"trailer-name-257": refused,
	"trailer-names-32x256": { unary: "ok", stream: "ok", files: "ok" },
	"fields-85": { unary: "ok", stream: "ok", files: "ok" },
	"fields-100": refused,
	"fields-101": refused,
	// Over Node's maxHeaderListPairs (128).
	"fields-140": refused,
	"headers-under-random": { ...connectOk, minHeaderBytes: nearLimit },
	"headers-under-repeated": { ...connectOk, minHeaderBytes: nearLimit },
	"headers-over-random": refused,
	"headers-over-repeated": refused,
	"trailer-under": { ...connectOk, minTrailerBytes: nearLimit },
	"trailer-over": trailersOver,
	// A block of exactly 64 KiB, over Node's maxHeaderListSize (65535).
	"trailer-edge": trailersOver,
	"trailer-over-declared": trailersOver,
	"trailer-fields-90": connectOk,
	"trailer-fields-101": trailersOver,
	"trailer-fields-140": trailersOver,
	"headers-and-trailers": {
		...connectOk,
		minHeaderBytes: nearLimit,
		minTrailerBytes: nearLimit,
	},
};

/** Node's default maxHeaderListSize: no block sent to the client may be larger. */
const nodeMaxHeaderList = 65535;
/** Upper bound of one call to the hostile machine (no retry loop). */
const maxHostileCallMs = 2000;

/** HTTP/2 size of a Node header object: name, value and 32 per field. */
function blockBytes(h: Record<string, unknown>): number {
	let n = 0;
	for (const [k, v] of Object.entries(h)) {
		for (const x of Array.isArray(v) ? v : [v]) {
			n += Buffer.byteLength(k) + Buffer.byteLength(String(x)) + 32;
		}
	}
	return n;
}

interface StreamRecord {
	path: string;
	callId: string | undefined;
	session: ClientHttp2Session;
	headerBytes: number;
	trailerBytes: number;
	rstCode: number | undefined;
	errors: unknown[];
}

/**
 * Watches the client's HTTP/2 traffic through diagnostics channels: TCP
 * sockets to the gateway (undici's /files sockets told apart), HTTP/2
 * sessions and their close/error/goaway events, and every stream with its
 * header and trailer block sizes, reset code and errors.
 */
class H2Watch {
	readonly streams: StreamRecord[] = [];
	readonly sessions = new Set<ClientHttp2Session>();
	readonly sessionEvents: string[] = [];
	/** Client sockets with the remote port they connected to (kept after close). */
	private readonly sockets: { socket: Socket; port: number | undefined }[] = [];
	private readonly undiciSockets = new WeakSet<object>();
	private readonly byStream = new WeakMap<ClientHttp2Stream, StreamRecord>();

	private readonly onSocket = (m: unknown) => {
		const socket = (m as { socket: Socket }).socket;
		const rec: { socket: Socket; port: number | undefined } = {
			socket,
			port: undefined,
		};
		this.sockets.push(rec);
		socket.once("connect", () => {
			rec.port = socket.remotePort;
		});
	};
	private readonly onUndici = (m: unknown) => {
		this.undiciSockets.add((m as { socket: object }).socket);
	};
	private readonly onStream = (m: unknown) => {
		const stream = (m as { stream: ClientHttp2Stream }).stream;
		const sent = stream.sentHeaders as Record<string, unknown>;
		const session = stream.session as ClientHttp2Session;
		const rec: StreamRecord = {
			path: String(sent[":path"] ?? ""),
			callId: sent["x-call-id"] as string | undefined,
			session,
			headerBytes: 0,
			trailerBytes: 0,
			rstCode: undefined,
			errors: [],
		};
		this.streams.push(rec);
		this.byStream.set(stream, rec);
		if (!this.sessions.has(session)) {
			this.sessions.add(session);
			session.on("close", () => this.sessionEvents.push("close"));
			session.on("error", (err) =>
				this.sessionEvents.push(`error ${String(err)}`),
			);
			session.on("goaway", (code) => this.sessionEvents.push(`goaway ${code}`));
			session.on("frameError", (type, code) =>
				this.sessionEvents.push(`frameError ${type} ${code}`),
			);
		}
		stream.on("response", (h) => {
			rec.headerBytes = blockBytes(h);
		});
		stream.on("trailers", (h) => {
			rec.trailerBytes = blockBytes(h);
		});
		stream.on("close", () => {
			rec.rstCode = stream.rstCode;
		});
	};
	private readonly onStreamError = (m: unknown) => {
		const { stream, error } = m as {
			stream: ClientHttp2Stream;
			error: unknown;
		};
		this.byStream.get(stream)?.errors.push(error);
	};

	subscribe(): void {
		dc.subscribe("net.client.socket", this.onSocket);
		dc.subscribe("undici:client:connected", this.onUndici);
		dc.subscribe("http2.client.stream.created", this.onStream);
		dc.subscribe("http2.client.stream.error", this.onStreamError);
	}

	unsubscribe(): void {
		dc.unsubscribe("net.client.socket", this.onSocket);
		dc.unsubscribe("undici:client:connected", this.onUndici);
		dc.unsubscribe("http2.client.stream.created", this.onStream);
		dc.unsubscribe("http2.client.stream.error", this.onStreamError);
	}

	/** TCP connections to port that are not undici's (the HTTP/2 sessions). */
	h2Sockets(port: number): number {
		return this.sockets.filter(
			(s) => s.port === port && !this.undiciSockets.has(s.socket),
		).length;
	}

	/** Connections to port opened by undici (fetch of /files). */
	fetchSockets(port: number): number {
		return this.sockets.filter(
			(s) => s.port === port && this.undiciSockets.has(s.socket),
		).length;
	}

	/** Waits until every stream seen has closed, up to ms. */
	async settled(ms: number): Promise<void> {
		const deadline = Date.now() + ms;
		while (this.streams.some((s) => s.rstCode === undefined)) {
			if (Date.now() > deadline) {
				return;
			}
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	forMachine(id: string): StreamRecord[] {
		return this.streams.filter((s) => s.path.includes(`/machines/${id}/`));
	}

	forCall(callId: string): StreamRecord[] {
		return this.streams.filter((s) => s.callId === callId);
	}
}

/** Output of the Process double for lines [0, n) of one stream (Go process.Expected). */
function expectedStream(
	name: "stdout" | "stderr",
	n: number,
	lineBytes: number,
): Buffer {
	const parts: Buffer[] = [];
	for (let k = name === "stdout" ? 0 : 1; k < n; k += 2) {
		const line = Buffer.alloc(lineBytes, ".");
		line.write(`${name} ${k} `.slice(0, lineBytes - 1));
		line[lineBytes - 1] = 0x0a;
		parts.push(line);
	}
	return Buffer.concat(parts);
}

function streamName(s: Stream): "stdout" | "stderr" {
	if (s === Stream.STDOUT) {
		return "stdout";
	}
	if (s === Stream.STDERR) {
		return "stderr";
	}
	throw new Error(`unexpected stream ${s}`);
}

interface Read {
	out: { stdout: Buffer; stderr: Buffer };
	exit: Extract<AttachResponse["event"], { case: "exit" }>["value"] | undefined;
}

/**
 * Reads Run or Attach events to the end: offsets must be contiguous from 0,
 * truncated never comes, exit comes last. progress is updated as data comes.
 */
async function readCommand(
	events: AsyncIterable<AttachResponse>,
	onStarted?: () => void,
	progress?: { bytes: number },
): Promise<Read> {
	const parts = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	const at = { stdout: 0n, stderr: 0n };
	let exit: Read["exit"];
	for await (const ev of events) {
		switch (ev.event.case) {
			case "data": {
				const s = streamName(ev.event.value.stream);
				expect(ev.event.value.offset, `${s} offset`).toBe(at[s]);
				expect(exit, "data after exit").toBeUndefined();
				parts[s].push(Buffer.from(ev.event.value.data));
				at[s] += BigInt(ev.event.value.data.length);
				if (progress !== undefined) {
					progress.bytes += ev.event.value.data.length;
				}
				break;
			}
			case "truncated":
				throw new Error("unexpected truncated event");
			case "exit":
				exit = ev.event.value;
				break;
			case "started":
				onStarted?.();
				break;
			default:
				break;
		}
	}
	return {
		out: {
			stdout: Buffer.concat(parts.stdout),
			stderr: Buffer.concat(parts.stderr),
		},
		exit,
	};
}

function sha(b: Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}

function badAgentDetail(err: ConnectError): string | undefined {
	return err.findDetails(ErrorDetailSchema)[0]?.code;
}

describe.skipIf(skipPg())(
	"e2e: hostile agent headers on a shared HTTP/2 session",
	() => {
		let db: TestDatabase | undefined;
		let harness: Harness | undefined;
		let registry: PgRegistry | undefined;
		let client: AgentClient | undefined;
		let failed = true;
		const watch = new H2Watch();

		beforeAll(async () => {
			watch.subscribe();
			db = await createTestDatabase({ migrate: false });
			harness = await startHarness({
				databaseUrl: db.connectionString,
				serviceToken,
				gateways: 1,
				agents: 3,
				hostile: 0,
			});
			registry = await PgRegistry.connect({
				connectionString: db.connectionString,
			});
			// The default transport: one HTTP/2 session per gateway origin. A
			// short wait budget keeps a regression to a retry loop visible.
			client = new AgentClient({
				registry,
				serviceToken,
				pollIntervalMs: 100,
				waitForAgentMs: 3000,
			});
			failed = false;
		}, 180_000);

		afterAll(async () => {
			let code: number | null | undefined;
			try {
				await client?.close();
				await registry?.close();
			} finally {
				watch.unsubscribe();
				try {
					code = await harness?.stop();
				} finally {
					await db?.drop();
				}
			}
			if (failed || process.env.SBX_E2E_KEEP_LOG === "1") {
				console.error(`tunnel harness log kept at ${harness?.logPath ?? "-"}`);
			} else {
				await removeHarnessBuild();
			}
			if (harness !== undefined) {
				expect(code, "harness exit code").toBe(0);
			}
		}, 60_000);

		it(
			`keeps other machines' calls and the session through ${repetitions} rounds of header attacks`,
			async () => {
				onTestFailed(() => {
					failed = true;
					console.error(`tunnel harness log: ${harness?.logPath}`);
				});
				if (harness === undefined || client === undefined) {
					throw new Error("setup failed");
				}
				const h = harness;
				const ac = client;
				const [idA, idB, idC] = h.machines as [string, string, string];
				const gwPort = Number(new URL(h.gateways[0]?.url ?? "").port);
				expect(h.gateways).toHaveLength(1);
				expect((await h.attacks()).sort()).toEqual(Object.keys(attacks).sort());

				let attacking = true;
				const calls = { b: 0, c: 0 };
				const counted = (m: "b" | "c") => {
					calls[m]++;
				};

				// Long streams: a slow command per machine, read by Run and by
				// Attach for the whole attack phase, then killed.
				const longLine = 64;
				const startLong = async (id: string, m: "b" | "c") => {
					const proc = createClient(Process, ac.transport(id));
					const commandId = `long-${m}-${randomUUID()}`;
					const progress = { run: { bytes: 0 }, attach: { bytes: 0 } };
					let started: () => void = () => {};
					const isStarted = new Promise<void>((r) => {
						started = r;
					});
					counted(m);
					const run = readCommand(
						proc.run({
							commandId,
							spec: {
								lines: 1_000_000,
								lineBytes: longLine,
								interval: { seconds: 0n, nanos: 2_000_000 },
								exitCode: 0,
							},
						}),
						started,
						progress.run,
					);
					await isStarted;
					counted(m);
					const attach = readCommand(
						proc.attach({ commandId, stdoutOffset: 0n, stderrOffset: 0n }),
						undefined,
						progress.attach,
					);
					return { proc, commandId, progress, run, attach };
				};

				// Short streams and unary calls in a loop until the attacks end.
				const churn = async (id: string, m: "b" | "c") => {
					const proc = createClient(Process, ac.transport(id));
					const lines = 200;
					const lineBytes = 512;
					const want = {
						stdout: expectedStream("stdout", lines, lineBytes),
						stderr: expectedStream("stderr", lines, lineBytes),
					};
					let rounds = 0;
					while (attacking || rounds === 0) {
						const commandId = `churn-${m}-${randomUUID()}`;
						let started: () => void = () => {};
						const isStarted = new Promise<void>((r) => {
							started = r;
						});
						counted(m);
						const run = readCommand(
							proc.run({
								commandId,
								spec: {
									lines,
									lineBytes,
									interval: { seconds: 0n, nanos: 0 },
									exitCode: 7,
								},
							}),
							started,
						);
						const unary = (async () => {
							for (let i = 0; i < 4; i++) {
								const payload = randomBytes(Math.floor(Math.random() * 16_384));
								counted(m);
								const res = await proc.echo({ payload });
								expect(sha(res.payload)).toBe(sha(payload));
							}
						})();
						await isStarted;
						counted(m);
						const attach = readCommand(
							proc.attach({ commandId, stdoutOffset: 0n, stderrOffset: 0n }),
						);
						const [r1, r2] = await Promise.all([run, attach, unary]);
						for (const r of [r1, r2]) {
							expect(sha(r.out.stdout)).toBe(sha(want.stdout));
							expect(sha(r.out.stderr)).toBe(sha(want.stderr));
							expect(r.exit?.status).toBe(ExitStatus.EXITED);
							expect(r.exit?.code).toBe(7);
							expect(r.exit?.stdoutEnd).toBe(BigInt(want.stdout.length));
							expect(r.exit?.stderrEnd).toBe(BigInt(want.stderr.length));
						}
						rounds++;
					}
					return rounds;
				};

				const procA = createClient(Process, ac.transport(idA));
				const streamCount = 3;
				const outcomes: Record<string, number> = {};
				const tally = (k: string) => {
					outcomes[k] = (outcomes[k] ?? 0) + 1;
				};
				let hostileCalls = 0;

				const unaryA = async (attack: string, e: Expect) => {
					const callId = randomUUID();
					const payload = randomBytes(256);
					const t0 = Date.now();
					hostileCalls++;
					let res: Awaited<ReturnType<typeof procA.echo>> | undefined;
					let err: unknown;
					try {
						res = await procA.echo(
							{ attack, payload },
							{ headers: { "X-Call-Id": callId } },
						);
					} catch (e) {
						err = e;
					}
					const what = `${attack} unary`;
					expect(Date.now() - t0, `${what} time`).toBeLessThan(
						maxHostileCallMs,
					);
					if (e.unary === "ok") {
						expect(err, what).toBeUndefined();
						expect(sha(res?.payload ?? new Uint8Array()), what).toBe(
							sha(payload),
						);
					} else {
						expect(err, what).toBeInstanceOf(ConnectError);
						const ce = err as ConnectError;
						expect(ce.code, `${what}: ${ce.message}`).toBe(Code.Internal);
						expect(badAgentDetail(ce), what).toBe("bad_agent_response");
						expect(classify(ce), what).toBe("fatal");
					}
					tally(`unary ${e.unary}`);
					return { callId, what, e };
				};

				const streamA = async (attack: string, e: Expect) => {
					const callId = randomUUID();
					const payload = randomBytes(256);
					const t0 = Date.now();
					hostileCalls++;
					const got: number[] = [];
					let err: unknown;
					try {
						for await (const m of procA.echoStream(
							{ attack, payload, count: streamCount },
							{ headers: { "X-Call-Id": callId } },
						)) {
							expect(sha(m.payload)).toBe(sha(payload));
							got.push(m.index);
						}
					} catch (e) {
						err = e;
					}
					const what = `${attack} stream`;
					expect(Date.now() - t0, `${what} time`).toBeLessThan(
						maxHostileCallMs,
					);
					switch (e.stream) {
						case "ok":
							expect(err, what).toBeUndefined();
							expect(got, what).toEqual([0, 1, 2]);
							break;
						case "refused": {
							expect(got, what).toEqual([]);
							expect(err, what).toBeInstanceOf(ConnectError);
							const ce = err as ConnectError;
							expect(ce.code, `${what}: ${ce.message}`).toBe(Code.Internal);
							expect(badAgentDetail(ce), what).toBe("bad_agent_response");
							expect(classify(ce), what).toBe("fatal");
							break;
						}
						case "reset": {
							// Every message arrived; the reset comes with the trailers.
							expect(got, what).toEqual([0, 1, 2]);
							expect(err, what).toBeInstanceOf(ConnectError);
							expect((err as ConnectError).code, what).toBe(Code.Internal);
							break;
						}
						default:
							throw new Error(`${what}: unexpected outcome ${e.stream}`);
					}
					tally(`stream ${e.stream}`);
					return { callId, what, e };
				};

				const filesA = async (attack: string, e: Expect) => {
					const callId = randomUUID();
					const t0 = Date.now();
					hostileCalls++;
					const res = await ac.fetch(idA, `/hostile/${attack}`, {
						headers: { "X-Call-Id": callId },
					});
					const body = await res.text();
					const what = `${attack} files`;
					expect(Date.now() - t0, `${what} time`).toBeLessThan(
						maxHostileCallMs,
					);
					if (e.files === "ok") {
						expect(res.status, what).toBe(200);
						expect(body, what).toBe(`hostile files body: ${attack}`);
					} else {
						expect(res.status, what).toBe(502);
						expect(JSON.parse(body).code, what).toBe("bad_agent_response");
					}
					tally(`files ${e.files}`);
					return { callId, what, e };
				};

				const longB = await startLong(idB, "b");
				const longC = await startLong(idC, "c");
				const churners = Promise.all([churn(idB, "b"), churn(idC, "c")]);
				// A failed call of B or C stops the attacks at once.
				let otherFailure: unknown;
				const others = Promise.all([
					churners,
					longB.run,
					longB.attach,
					longC.run,
					longC.attach,
				]).catch((err: unknown) => {
					otherFailure ??= err;
				});

				type Done = { callId: string; what: string; e: Expect };
				const t0 = Date.now();
				const bytesAtStart = [longB, longC].map((l) => l.progress.attach.bytes);
				const results: Done[] = [];
				const hostileFailures: unknown[] = [];
				try {
					for (
						let round = 0;
						round < repetitions && otherFailure === undefined;
						round++
					) {
						const batch: Promise<Done>[] = [];
						for (const [attack, e] of Object.entries(attacks)) {
							if (e.unary !== "skip") {
								batch.push(unaryA(attack, e));
							}
							if (e.stream !== "skip") {
								batch.push(streamA(attack, e));
							}
							if (e.files !== "skip") {
								batch.push(filesA(attack, e));
							}
						}
						for (const r of await Promise.allSettled(batch)) {
							if (r.status === "fulfilled") {
								results.push(r.value);
							} else {
								hostileFailures.push(r.reason);
							}
						}
					}
				} finally {
					attacking = false;
				}
				const attackMs = Date.now() - t0;
				const progressed = [longB, longC].map(
					(l, i) => l.progress.attach.bytes > (bytesAtStart[i] ?? 0),
				);
				// End the long commands; their readers then see the exit.
				for (const l of [longB, longC]) {
					await l.proc
						.signal({ commandId: l.commandId, signal: "SIGKILL" })
						.catch((err: unknown) => {
							otherFailure ??= err;
						});
				}
				calls.b++;
				calls.c++;
				await others;
				await watch.settled(30_000);

				console.log(
					`HTTP/2 sessions ${watch.sessions.size}, sockets to the gateway ${watch.h2Sockets(gwPort)}, ` +
						`session events ${watch.sessionEvents.length}, B/C failure: ${String(otherFailure ?? "none")}, ` +
						`hostile call failures ${hostileFailures.length}: ${[
							...new Set(hostileFailures.map((f) => String(f).split("\n")[0])),
						]
							.slice(0, 8)
							.join(" | ")}`,
				);
				// One session to the gateway for the whole test, never closed.
				expect(watch.sessionEvents, "session events").toEqual([]);
				expect(watch.sessions.size, "HTTP/2 sessions").toBe(1);
				expect(watch.h2Sockets(gwPort), "HTTP/2 sockets to the gateway").toBe(
					1,
				);
				for (const s of watch.sessions) {
					expect(s.closed || s.destroyed, "session closed").toBe(false);
				}

				// B and C: every call completed exactly, one HTTP/2 stream per call
				// (no retry hid an error), none reset or failed.
				if (otherFailure !== undefined) {
					throw otherFailure;
				}
				for (const [m, id] of [
					["b", idB],
					["c", idC],
				] as const) {
					const streams = watch.forMachine(id);
					expect(streams.length, `${m} HTTP/2 streams`).toBe(calls[m]);
					for (const s of streams) {
						expect(s.errors, `${m} ${s.path} errors`).toEqual([]);
						expect(s.rstCode, `${m} ${s.path} reset code`).toBe(0);
					}
				}
				// The long streams flowed through the attack phase and are exact.
				expect(progressed, "long streams progressed").toEqual([true, true]);
				for (const l of [longB, longC]) {
					for (const r of [await l.run, await l.attach]) {
						expect(r.exit?.status).toBe(ExitStatus.KILLED);
						expect(r.exit?.stdoutEnd).toBe(BigInt(r.out.stdout.length));
						expect(r.exit?.stderrEnd).toBe(BigInt(r.out.stderr.length));
						const n =
							r.out.stdout.length / longLine + r.out.stderr.length / longLine;
						expect(Number.isInteger(n)).toBe(true);
						expect(sha(r.out.stdout)).toBe(
							sha(expectedStream("stdout", n, longLine)),
						);
						expect(sha(r.out.stderr)).toBe(
							sha(expectedStream("stderr", n, longLine)),
						);
					}
				}

				// A: every call ended as expected, within the bound, after one
				// request: no retry loop.
				if (hostileFailures.length > 0) {
					throw hostileFailures[0];
				}
				expect(watch.forMachine(idA).length, "A HTTP/2 streams").toBe(
					results.filter((r) => !r.what.endsWith(" files")).length,
				);
				for (const { callId, what, e } of results) {
					expect(
						await h.hostileRequests(callId),
						`${what} agent requests`,
					).toBe(1);
					if (what.endsWith(" files")) {
						continue;
					}
					// The blocks near the limit reached the Node client whole.
					const got = watch.forCall(callId);
					expect(got.length, `${what} HTTP/2 streams`).toBe(1);
					const s = got[0];
					if (s === undefined) {
						continue;
					}
					expect(s.headerBytes, `${what} header block`).toBeLessThanOrEqual(
						nodeMaxHeaderList,
					);
					expect(s.trailerBytes, `${what} trailer block`).toBeLessThanOrEqual(
						nodeMaxHeaderList,
					);
					expect(s.headerBytes, `${what} header block`).toBeGreaterThanOrEqual(
						e.minHeaderBytes ?? 0,
					);
					expect(
						s.trailerBytes,
						`${what} trailer block`,
					).toBeGreaterThanOrEqual(e.minTrailerBytes ?? 0);
				}
				const rounds = await churners;
				console.log(
					`${repetitions} rounds, ${hostileCalls} hostile calls in ${attackMs} ms ` +
						`(${JSON.stringify(outcomes)}); B/C calls ${calls.b}/${calls.c}, ` +
						`churn rounds ${rounds.join("/")}; fetch sockets ${watch.fetchSockets(gwPort)}`,
				);
			},
			long ? 600_000 : 180_000,
		);
	},
);
