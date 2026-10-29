// Cross-language e2e (spec section 14.1, scaled down): the TS agent-client
// against the Go gateways and agent of the tunnel harness, with random faults
// while two readers follow a command's output. SBX_E2E_KEEP_LOG=1 keeps the
// harness log (stderr) also when the test passes; its path is printed.
import { createHash, randomUUID } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
	type Client,
	createClient,
	type Interceptor,
	type Transport,
} from "@connectrpc/connect";
import {
	createConnectTransport,
	Http2SessionManager,
} from "@connectrpc/connect-node";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	onTestFailed,
} from "vitest";
import {
	AgentClient,
	type AttachView,
	classify,
	PgRegistry,
	resumableAttach,
} from "../src/index.js";
import {
	type AttachResponse,
	type CommandSpecSchema,
	type ExitEvent,
	ExitStatus,
	Process,
	Stream,
} from "./gen/sbx/testing/v1/process_pb.js";
import {
	FAULT_KINDS,
	type FaultKind,
	type FaultResult,
	type Harness,
	removeHarnessBuild,
	startHarness,
} from "./helpers/harness.js";
import { createTestDatabase, skipPg, type TestDatabase } from "./helpers/pg.js";

const serviceToken = "e2e-service-token";
const lines = 3000;
const lineBytes = 512;
const exitCode = 42;
/** Scaled pause budget of spec 14.1 (30 s there). */
const maxPauseMs = 5000;

/** Expected output of the Process double (same formula as Go process.Expected). */
function expectedOutput(n: number, lb: number): Record<string, Buffer> {
	const out: Record<string, Buffer[]> = { stdout: [], stderr: [] };
	for (let k = 0; k < n; k++) {
		const stream = k % 2 === 0 ? "stdout" : "stderr";
		const head = `${stream} ${k} `;
		const line = Buffer.alloc(lb, ".");
		line.write(head.slice(0, lb - 1));
		line[lb - 1] = 0x0a;
		out[stream]?.push(line);
	}
	return {
		stdout: Buffer.concat(out.stdout ?? []),
		stderr: Buffer.concat(out.stderr ?? []),
	};
}

function sha256(b: Uint8Array): string {
	return createHash("sha256").update(b).digest("hex");
}

function streamName(s: Stream): string {
	switch (s) {
		case Stream.STDOUT:
			return "stdout";
		case Stream.STDERR:
			return "stderr";
		default:
			return "pty";
	}
}

function view(ev: AttachResponse): AttachView {
	switch (ev.event.case) {
		case "data":
			return {
				kind: "data",
				stream: streamName(ev.event.value.stream),
				offset: ev.event.value.offset,
				data: ev.event.value.data,
			};
		case "truncated":
			return {
				kind: "truncated",
				stream: streamName(ev.event.value.stream),
				availableFrom: ev.event.value.availableFrom,
			};
		case "exit":
			return {
				kind: "exit",
				ends: {
					stdout: ev.event.value.stdoutEnd,
					stderr: ev.event.value.stderrEnd,
				},
			};
		default:
			return { kind: "other" };
	}
}

/** Errors the agent-client saw and retried; they never reach the test. */
interface Retried {
	errors: unknown[];
}

/** Passes the stream through and records an error before rethrowing it. */
async function* recording<T>(
	it: AsyncIterable<T>,
	into: Retried,
): AsyncGenerator<T> {
	try {
		yield* it;
	} catch (err) {
		into.errors.push(err);
		throw err;
	}
}

interface ReadResult {
	hash: Record<string, string>;
	bytes: Record<string, number>;
	exit: ExitEvent | undefined;
	opens: number;
	truncated: number;
	maxPauseMs: number;
	retried: Retried;
}

/** Reads a command to its exit with resumableAttach and hashes each stream. */
async function readAll(
	open: (
		offsets: Record<string, bigint>,
		signal: AbortSignal,
	) => AsyncIterable<AttachResponse>,
	onStarted?: () => void,
): Promise<ReadResult> {
	const hashes = {
		stdout: createHash("sha256"),
		stderr: createHash("sha256"),
	};
	const bytes: Record<string, number> = { stdout: 0, stderr: 0 };
	const retried: Retried = { errors: [] };
	let opens = 0;
	let truncated = 0;
	let exit: ExitEvent | undefined;
	let last: number | undefined;
	let maxPause = 0;
	const events = resumableAttach<AttachResponse>({
		open: (offsets, signal) => {
			opens++;
			return recording(open(offsets, signal), retried);
		},
		view,
		offsets: {},
	});
	for await (const out of events) {
		switch (out.type) {
			case "data": {
				const now = Date.now();
				if (last !== undefined) {
					maxPause = Math.max(maxPause, now - last);
				}
				last = now;
				expect(out.offset).toBe(BigInt(bytes[out.stream] ?? -1));
				hashes[out.stream as "stdout" | "stderr"].update(out.data);
				bytes[out.stream] = (bytes[out.stream] ?? 0) + out.data.length;
				break;
			}
			case "truncated":
				truncated++;
				break;
			case "exit":
				if (out.event.event.case === "exit") {
					exit = out.event.event.value;
				}
				break;
			case "other":
				if (out.event.event.case === "started") {
					onStarted?.();
				}
				break;
		}
	}
	return {
		hash: {
			stdout: hashes.stdout.digest("hex"),
			stderr: hashes.stderr.digest("hex"),
		},
		bytes,
		exit,
		opens,
		truncated,
		maxPauseMs: maxPause,
		retried,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(skipPg())("e2e: agent-client against the Go tunnel", () => {
	let db: TestDatabase | undefined;
	let harness: Harness | undefined;
	let registry: PgRegistry | undefined;
	let client: AgentClient | undefined;
	// Logs are kept when setup or the test failed.
	let failed = true;
	const sessions = new Map<string, Http2SessionManager>();
	/** Errors of single attempts (before response headers), all retried by routing. */
	const attemptErrors: { method: string; err: unknown }[] = [];

	// Same as the default transport (one HTTP/2 session per gateway origin)
	// but without compression: the double's output compresses ~1000:1 and
	// would hide envelope-level faults.
	function noCompressionTransport(
		baseUrl: string,
		headers: Record<string, string>,
	): Transport {
		const origin = new URL(baseUrl).origin;
		let session = sessions.get(origin);
		if (session === undefined) {
			session = new Http2SessionManager(origin, {
				pingIntervalMs: 10_000,
				pingTimeoutMs: 5000,
			});
			sessions.set(origin, session);
		}
		const auth: Interceptor = (next) => (req) => {
			for (const [k, v] of Object.entries(headers)) {
				req.header.set(k, v);
			}
			return next(req);
		};
		const record: Interceptor = (next) => async (req) => {
			try {
				return await next(req);
			} catch (err) {
				attemptErrors.push({ method: req.method.name, err });
				throw err;
			}
		};
		return createConnectTransport({
			baseUrl,
			httpVersion: "2",
			sessionManager: session,
			acceptCompression: [],
			interceptors: [record, auth],
		});
	}

	beforeAll(async () => {
		db = await createTestDatabase({ migrate: false });
		harness = await startHarness({
			databaseUrl: db.connectionString,
			serviceToken,
			gateways: 2,
			agents: 1,
		});
		registry = await PgRegistry.connect({
			connectionString: db.connectionString,
		});
		client = new AgentClient({
			registry,
			serviceToken,
			pollIntervalMs: 100,
			createTransport: noCompressionTransport,
		});
		failed = false;
	}, 180_000);

	afterAll(async () => {
		let code: number | null | undefined;
		try {
			await client?.close();
			for (const s of sessions.values()) {
				s.abort();
			}
			await registry?.close();
		} finally {
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

	it("keeps both readers exact and SetLabel single through random faults", async () => {
		onTestFailed(() => {
			failed = true;
			console.error(`tunnel harness log: ${harness?.logPath}`);
		});
		if (harness === undefined || client === undefined) {
			throw new Error("setup failed");
		}
		const h = harness;
		const machine = h.machines[0] ?? "";
		const proc: Client<typeof Process> = createClient(
			Process,
			client.transport(machine),
		);
		const commandId = `e2e-${randomUUID()}`;
		const spec: MessageInitShape<typeof CommandSpecSchema> = {
			lines,
			lineBytes,
			interval: { seconds: 0n, nanos: 1_000_000 },
			exitCode,
		};
		const want = expectedOutput(lines, lineBytes);

		// Reader 1 runs the command (Run until "started" was seen, Attach after).
		let started = false;
		let onStarted: () => void = () => {};
		const startedSeen = new Promise<void>((r) => {
			onStarted = r;
		});
		const reader1 = readAll(
			(offsets, signal) =>
				started
					? proc.attach(
							{
								commandId,
								stdoutOffset: offsets.stdout ?? 0n,
								stderrOffset: offsets.stderr ?? 0n,
							},
							{ signal },
						)
					: proc.run({ commandId, spec }, { signal }),
			() => {
				started = true;
				onStarted();
			},
		);
		// Reader 2 attaches by commandId from offset 0 once the command exists.
		const reader2 = startedSeen.then(() =>
			readAll((offsets, signal) =>
				proc.attach(
					{
						commandId,
						stdoutOffset: offsets.stdout ?? 0n,
						stderrOffset: offsets.stderr ?? 0n,
					},
					{ signal },
				),
			),
		);

		let done = false;
		const readers = Promise.all([reader1, reader2]).finally(() => {
			done = true;
		});
		const injected: Record<FaultKind, number> = {
			cut: 0,
			stall: 0,
			drain: 0,
			"kill-gateway": 0,
			"restart-agent": 0,
		};
		let busy = 0;
		const results: FaultResult[] = [];
		// Kinds come from a shuffled bag so every kind is injected; a kind the
		// harness refused (busy) goes back into the bag.
		let bag: FaultKind[] = [];
		const injector = (async () => {
			while (!done) {
				await sleep(100 + Math.random() * 300);
				if (done) {
					break;
				}
				if (bag.length === 0) {
					bag = shuffle([...FAULT_KINDS]);
				}
				const kind = bag.pop() ?? "cut";
				const r = await h.fault(kind, machine);
				if (r === "busy") {
					busy++;
					bag.unshift(kind);
				} else {
					injected[kind]++;
					results.push(r);
				}
			}
		})();

		const [read, inject] = await Promise.allSettled([readers, injector]);
		if (inject.status === "rejected") {
			throw inject.reason;
		}
		if (read.status === "rejected") {
			throw read.reason;
		}
		const [r1, r2] = read.value;
		const total = Object.values(injected).reduce((a, b) => a + b, 0);
		console.log(
			`faults injected ${JSON.stringify(injected)} (total ${total}, busy ${busy})`,
		);

		for (const [name, r] of [
			["reader 1", r1],
			["reader 2", r2],
		] as const) {
			console.log(
				`${name}: ${r.opens} opens, ${r.bytes.stdout}+${r.bytes.stderr} bytes, max pause ${r.maxPauseMs} ms, retried errors ${r.retried.errors.length}: ${summarize(r.retried.errors)}`,
			);
			expect(r.bytes).toEqual({
				stdout: want.stdout?.length,
				stderr: want.stderr?.length,
			});
			expect(r.hash.stdout).toBe(sha256(want.stdout ?? Buffer.alloc(0)));
			expect(r.hash.stderr).toBe(sha256(want.stderr ?? Buffer.alloc(0)));
			expect(r.exit?.status).toBe(ExitStatus.EXITED);
			expect(r.exit?.code).toBe(exitCode);
			expect(r.truncated).toBe(0);
			expect(r.maxPauseMs).toBeLessThanOrEqual(maxPauseMs);
			for (const err of r.retried.errors) {
				expect(classify(err)).not.toBe("fatal");
			}
		}
		for (const kind of FAULT_KINDS) {
			expect(injected[kind], kind).toBeGreaterThanOrEqual(1);
		}
		// The faults hit the machine's tunnel and forced the readers to resume.
		for (const r of results) {
			expect(r.applied, `${r.kind} applied`).toBe(true);
		}
		const linkFaults = results.filter(
			(r) => (r.kind === "cut" || r.kind === "stall") && r.links >= 1,
		);
		expect(
			linkFaults.length,
			"cut/stall faults that touched a link",
		).toBeGreaterThanOrEqual(1);
		for (const [name, r] of [
			["reader 1", r1],
			["reader 2", r2],
		] as const) {
			expect(r.opens, `${name} opens`).toBeGreaterThan(1);
			expect(
				r.retried.errors.length,
				`${name} retried errors`,
			).toBeGreaterThanOrEqual(1);
		}
		expect(await h.starts(commandId)).toBe(1);

		// A mutating unary call right after a gateway crash. The cached route
		// may be dead (then the client retries until the agent is back), or the
		// registry may already point at the new gateway. This check proves
		// single execution after a dead route; it does not prove that a retry
		// was forced (attempt errors below are logged, not required).
		await injectEventually(h, "kill-gateway", machine);
		const requestId = randomUUID();
		const res = await proc.setLabel(
			{ commandId, label: "after-faults" },
			{ headers: { "Sbx-Request-Id": requestId } },
		);
		expect(res.calls).toBe(1n);
		expect(await h.labelCalls(commandId)).toBe(1);

		for (const method of new Set(attemptErrors.map((a) => a.method))) {
			const errs = attemptErrors.filter((a) => a.method === method);
			console.log(
				`${method}: attempt errors retried by routing ${errs.length}: ${summarize(errs.map((a) => a.err))}`,
			);
		}
		for (const { err } of attemptErrors) {
			expect(classify(err)).not.toBe("fatal");
		}
	}, 120_000);
});

function shuffle<T>(a: T[]): T[] {
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j] as T, a[i] as T];
	}
	return a;
}

/** Injects a fault, retrying while the harness answers busy. */
async function injectEventually(
	h: Harness,
	kind: FaultKind,
	machine: string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while ((await h.fault(kind, machine)) === "busy") {
		if (Date.now() > deadline) {
			throw new Error(`fault ${kind} stayed busy for 10 s`);
		}
		await sleep(50);
	}
}

/** Error counts by Connect code and message, for the log. */
function summarize(errors: unknown[]): string {
	const counts = new Map<string, number>();
	for (const e of errors) {
		const c = e as { code?: unknown; rawMessage?: unknown; message?: unknown };
		const key = `${String(c.code)}:${String(c.rawMessage ?? c.message)}`.slice(
			0,
			120,
		);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return JSON.stringify(Object.fromEntries(counts));
}
