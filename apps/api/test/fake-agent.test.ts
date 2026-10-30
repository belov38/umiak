// The S3 contract that FakeAgent implements (and the real adapter must):
// Start idempotency, attach semantics (offsets, truncated, heartbeat, exit
// after all output), input dedupe, PTY, signals, files HTTP and Filesystem.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	AgentOutdatedError,
	AgentUnavailableError,
	resumableAttach,
} from "@sbx/agent-client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	type AgentAttachEvent,
	AgentCallError,
	type AgentCommandSpec,
	agentHttpError,
	parseAgentFileInfo,
} from "../src/index.ts";
import { FakeAgent } from "../src/testing/index.ts";
import { shellGate, until, WAIT_MS } from "./helpers/commands.ts";
import { tarEntry, tarOf } from "./helpers/files.ts";

const fake = new FakeAgent();
afterAll(() => fake.close());
afterEach(() => {
	fake.chunkSize = 64 * 1024;
	fake.heartbeatMs = 15_000;
	fake.retention(null);
});

const enc = new TextEncoder();
const dec = new TextDecoder();

function spec(over: Partial<AgentCommandSpec>): AgentCommandSpec {
	return {
		cwd: "",
		env: {},
		user: "user",
		stdin: false,
		timeoutMs: 0,
		tags: {},
		...over,
	};
}

function newMachine(): string {
	const id = randomUUID();
	fake.machine(id);
	return id;
}

async function start(m: string, s: AgentCommandSpec): Promise<string> {
	const commandId = randomUUID();
	await fake.start(m, { commandId, spec: s }, { requestId: randomUUID() });
	return commandId;
}

interface Collected {
	events: AgentAttachEvent[];
	out: Record<string, string>;
	exit: Extract<AgentAttachEvent, { type: "exit" }> | undefined;
}

async function collect(
	it: AsyncIterable<AgentAttachEvent>,
	stopAfter = Number.POSITIVE_INFINITY,
): Promise<Collected> {
	const events: AgentAttachEvent[] = [];
	const bytes: Record<string, number[]> = {};
	let exit: Collected["exit"];
	for await (const ev of it) {
		events.push(ev);
		if (ev.type === "data") {
			const b = bytes[ev.stream] ?? [];
			b.push(...ev.data);
			bytes[ev.stream] = b;
		}
		if (ev.type === "exit") exit = ev;
		if (events.length >= stopAfter) break;
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(bytes)) {
		out[k] = dec.decode(new Uint8Array(v));
	}
	return { events, out, exit };
}

function attachAll(
	m: string,
	commandId: string,
	offsets: { stdout?: number; stderr?: number; pty?: number } = {},
	extra: { tailBytes?: number; follow?: boolean } = {},
): AsyncIterable<AgentAttachEvent> {
	return fake.attach(
		m,
		{
			commandId,
			stdoutOffset: offsets.stdout ?? 0,
			stderrOffset: offsets.stderr ?? 0,
			ptyOffset: offsets.pty ?? 0,
			...extra,
		},
		new AbortController().signal,
	);
}

async function run(
	m: string,
	s: AgentCommandSpec,
): Promise<Collected & { commandId: string }> {
	const commandId = await start(m, s);
	return { commandId, ...(await collect(attachAll(m, commandId))) };
}

function sha256(b: Uint8Array | string): string {
	return createHash("sha256").update(b).digest("hex");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("Start", () => {
	it("is idempotent by commandId: one process, created false on repeat", async () => {
		const m = newMachine();
		const commandId = randomUUID();
		const s = spec({ shell: "echo started >> count.txt; echo hi" });
		const a = await fake.start(
			m,
			{ commandId, spec: s },
			{ requestId: randomUUID() },
		);
		const b = await fake.start(
			m,
			{ commandId, spec: s },
			{ requestId: randomUUID() },
		);
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.command.commandId).toBe(commandId);
		expect(b.command.pid).toBe(a.command.pid);
		const r = await collect(attachAll(m, commandId));
		expect(r.out.stdout).toBe("hi\n");
		expect(fake.startCount(commandId)).toBe(1);
		expect(readFileSync(join(fake.machine(m).home, "count.txt"), "utf8")).toBe(
			"started\n",
		);
	});

	it("concurrent Start of one commandId launches one process", async () => {
		const m = newMachine();
		const commandId = randomUUID();
		const s = spec({ shell: "echo once" });
		const both = await Promise.all(
			[0, 1].map(() =>
				fake.start(m, { commandId, spec: s }, { requestId: randomUUID() }),
			),
		);
		expect(both.filter((r) => r.created)).toHaveLength(1);
		expect(fake.startCount(commandId, m)).toBe(1);
		expect((await collect(attachAll(m, commandId))).out.stdout).toBe("once\n");
	});

	it("equal command ids on two machines are separate commands", async () => {
		const m1 = newMachine();
		const m2 = newMachine();
		const id = randomUUID();
		const a = await fake.start(
			m1,
			{ commandId: id, spec: spec({ shell: "printf one" }) },
			{ requestId: "r" },
		);
		const b = await fake.start(
			m2,
			{ commandId: id, spec: spec({ shell: "printf two" }) },
			{ requestId: "r" },
		);
		expect([a.created, b.created]).toEqual([true, true]);
		expect((await collect(attachAll(m1, id))).out.stdout).toBe("one");
		expect((await collect(attachAll(m2, id))).out.stdout).toBe("two");
		expect(fake.startCount(id, m1)).toBe(1);
		expect(fake.startCount(id)).toBe(2);
		expect(fake.totalStarts(m1)).toBe(1);
	});

	it("rejects the same commandId with another spec: already_exists", async () => {
		const m = newMachine();
		const commandId = randomUUID();
		await fake.start(
			m,
			{ commandId, spec: spec({ shell: "true" }) },
			{ requestId: "r" },
		);
		const err = await fake
			.start(
				m,
				{ commandId, spec: spec({ shell: "false" }) },
				{ requestId: "r" },
			)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentCallError);
		expect((err as AgentCallError).code).toBe("already_exists");
	});

	it("runs argv without a shell, cwd relative to home, env applied", async () => {
		const m = newMachine();
		mkdirSync(join(fake.machine(m).home, "sub"));
		const r = await run(
			m,
			spec({
				argv: ["/bin/sh", "-c", 'pwd; printf "%s" "$FOO"'],
				cwd: "sub",
				env: { FOO: "bar baz" },
			}),
		);
		expect(r.out.stdout).toBe(`${join(fake.machine(m).home, "sub")}\nbar baz`);
		expect(r.exit).toMatchObject({ status: "exited", code: 0, reason: "none" });
		// An absolute guest cwd maps into the machine root.
		const abs = await run(m, spec({ shell: "pwd", cwd: "/home/user/sub" }));
		expect(abs.out.stdout).toBe(`${join(fake.machine(m).home, "sub")}\n`);
		const out = await run(m, spec({ shell: "pwd", cwd: "/../.." }));
		expect(out.exit?.reason).toBe("start_failed");
	});

	it("output of leftovers after exit is not counted; kill reaches leftovers", async () => {
		const m = newMachine();
		const r = await run(
			m,
			spec({
				shell:
					"echo main; (sleep 0.4; echo late) & echo $! > bg.pid; sleep 30 & echo $! >> bg.pid",
			}),
		);
		expect(r.out.stdout).toBe("main\n");
		expect(r.exit).toMatchObject({ status: "exited", code: 0, stdoutEnd: 5 });
		const pids = readFileSync(join(fake.machine(m).home, "bg.pid"), "utf8")
			.trim()
			.split("\n")
			.map(Number);
		expect(pids.some(pidAlive)).toBe(true);
		// The first leftover has printed "late" and ended.
		await until(() => !pidAlive(pids[0] as number), WAIT_MS, "late leftover");
		const info = await fake.get(m, r.commandId);
		expect(info.streams.stdout).toEqual({ size: 5, availableFrom: 0, end: 5 });
		await fake.kill(m, { commandId: r.commandId });
		await until(() => !pids.some(pidAlive), WAIT_MS, "leftovers killed");
	});

	it("a chatty leftover does not hold the exit for more than about a second", async () => {
		const m = newMachine();
		const t0 = Date.now();
		const r = await run(
			m,
			spec({
				shell:
					"(while :; do echo noise; sleep 0.02; done) & echo $! > bg.pid; echo main",
			}),
		);
		// The leftover never stops: without the cap (LEFTOVER_MAX_WAIT_MS, 1 s)
		// the exit never comes. The bound leaves room for a loaded machine.
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect(r.exit).toMatchObject({ status: "exited", code: 0 });
		expect(r.out.stdout).toContain("main\n");
		await fake.kill(m, { commandId: r.commandId });
	});

	it("the grace SIGKILL of Kill reaches leftovers after the main process died on SIGTERM", async () => {
		const m = newMachine();
		const commandId = await start(
			m,
			spec({
				shell:
					"(trap '' TERM; exec sh -c 'echo $$ > bg.pid; while :; do sleep 0.05; done') & sleep 30",
			}),
		);
		const pidFile = join(fake.machine(m).home, "bg.pid");
		const readPid = () =>
			existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : 0;
		const bg = await until(() => readPid() || null, WAIT_MS, "bg.pid");
		const graceMs = 300;
		const t0 = Date.now();
		await fake.kill(m, { commandId, graceMs });
		const r = await collect(attachAll(m, commandId));
		expect(r.exit).toMatchObject({ status: "killed", signal: "SIGTERM" });
		// The leftover outlives SIGTERM and dies only once the grace ran out
		// (a lower bound: a slow machine only makes it later).
		await until(() => !pidAlive(bg), WAIT_MS, "leftover killed");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(graceMs - 20);
	});

	it("a missing program is start_failed with code 127 and the error in stderr", async () => {
		const m = newMachine();
		const r = await run(m, spec({ argv: ["/nonexistent/prog"] }));
		expect(r.exit).toMatchObject({
			status: "exited",
			code: 127,
			reason: "start_failed",
		});
		expect(r.out.stderr).toContain("/nonexistent/prog");
	});

	it("get reports state, streams and exit", async () => {
		const m = newMachine();
		const r = await run(
			m,
			spec({ shell: "printf abc; printf de >&2; exit 3" }),
		);
		const info = await fake.get(m, r.commandId);
		expect(info.state).toBe("exited");
		expect(info.exit).toEqual({
			status: "exited",
			code: 3,
			signal: null,
			reason: "none",
		});
		expect(info.streams).toEqual({
			stdout: { size: 3, availableFrom: 0, end: 3 },
			stderr: { size: 2, availableFrom: 0, end: 2 },
		});
		expect(info.startedAt).toBeInstanceOf(Date);
		expect(info.endedAt).toBeInstanceOf(Date);
		const missing = await fake.get(m, randomUUID()).catch((e: unknown) => e);
		expect((missing as AgentCallError).code).toBe("command_not_found");
	});

	it("too_many_commands above maxRunningCommands", async () => {
		const f = new FakeAgent({ maxRunningCommands: 1 });
		try {
			const m = randomUUID();
			await f.start(
				m,
				{ commandId: "a", spec: spec({ shell: "sleep 30" }) },
				{ requestId: "r" },
			);
			const err = await f
				.start(
					m,
					{ commandId: "b", spec: spec({ shell: "true" }) },
					{ requestId: "r" },
				)
				.catch((e: unknown) => e);
			expect((err as AgentCallError).code).toBe("too_many_commands");
		} finally {
			await f.close();
		}
	});
});

describe("Attach", () => {
	it("reads from the middle of a stream", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "printf 'hello world'" }));
		const again = await collect(attachAll(m, r.commandId, { stdout: 6 }));
		const data = again.events.filter((e) => e.type === "data");
		expect(data[0]).toMatchObject({ stream: "stdout", offset: 6 });
		expect(again.out.stdout).toBe("world");
		expect(again.exit).toMatchObject({ stdoutEnd: 11, stderrEnd: 0 });
	});

	it("sends exit only after all output of every stream", async () => {
		const m = newMachine();
		fake.chunkSize = 4096;
		const r = await run(
			m,
			spec({
				shell: "for i in $(seq 1 3000); do echo out-$i; echo err-$i >&2; done",
			}),
		);
		const last = r.events.at(-1);
		expect(last?.type).toBe("exit");
		expect(r.events.filter((e) => e.type === "exit")).toHaveLength(1);
		const outLines = r.out.stdout?.trim().split("\n") ?? [];
		expect(outLines).toHaveLength(3000);
		expect(r.exit?.stdoutEnd).toBe(enc.encode(r.out.stdout).length);
		expect(r.exit?.stderrEnd).toBe(enc.encode(r.out.stderr).length);
		// Offsets are contiguous per stream.
		const next: Record<string, number> = { stdout: 0, stderr: 0 };
		for (const e of r.events) {
			if (e.type !== "data") continue;
			expect(e.offset).toBe(next[e.stream]);
			expect(e.data.length).toBeLessThanOrEqual(4096);
			next[e.stream] = e.offset + e.data.length;
		}
	});

	it("follows a running command until it exits", async () => {
		const m = newMachine();
		const commandId = await start(
			m,
			spec({ shell: "echo a; sleep 0.3; echo b" }),
		);
		const r = await collect(attachAll(m, commandId));
		expect(r.out.stdout).toBe("a\nb\n");
		expect(r.exit?.code).toBe(0);
	});

	it("sends truncated when the offset was evicted by retention", async () => {
		const m = newMachine();
		fake.retention(100);
		const r = await run(
			m,
			spec({ shell: "head -c 1000 /dev/zero | tr '\\0' x" }),
		);
		expect(r.events[0]).toEqual({
			type: "truncated",
			stream: "stdout",
			availableFrom: 900,
		});
		const data = r.events.find((e) => e.type === "data");
		expect(data).toMatchObject({ offset: 900 });
		expect(r.out.stdout).toBe("x".repeat(100));
		const info = await fake.get(m, r.commandId);
		expect(info.streams.stdout).toEqual({
			size: 1000,
			availableFrom: 900,
			end: 1000,
		});
	});

	it("tailBytes starts near the end; follow:false closes without exit while running", async () => {
		const m = newMachine();
		const done = await run(m, spec({ shell: "printf 0123456789" }));
		const tail = await collect(
			attachAll(m, done.commandId, {}, { tailBytes: 4 }),
		);
		expect(tail.out.stdout).toBe("6789");
		expect(tail.exit).toBeDefined();

		const commandId = await start(m, spec({ shell: "printf ab; sleep 30" }));
		await until(
			async () => (await fake.get(m, commandId)).streams.stdout?.size === 2,
		);
		const now = await collect(attachAll(m, commandId, {}, { follow: false }));
		expect(now.out.stdout).toBe("ab");
		expect(now.exit).toBeUndefined();
		await fake.kill(m, { commandId, graceMs: 0 });
	});

	it("sends heartbeats during silence", async () => {
		const m = newMachine();
		fake.heartbeatMs = 50;
		// Silent until two heartbeats came, however long that takes here.
		const gate = shellGate();
		const commandId = await start(
			m,
			spec({ shell: `${gate.shell}; echo done` }),
		);
		let beats = 0;
		const r = await collect(
			(async function* () {
				for await (const ev of attachAll(m, commandId)) {
					if (ev.type === "heartbeat" && ++beats === 2) gate.open();
					yield ev;
				}
			})(),
		);
		expect(
			r.events.filter((e) => e.type === "heartbeat").length,
		).toBeGreaterThanOrEqual(2);
		expect(r.out.stdout).toBe("done\n");
	});

	it("chunkSize 1 yields one byte per data event", async () => {
		const m = newMachine();
		fake.chunkSize = 1;
		const r = await run(m, spec({ shell: "printf 'é€'" }));
		const data = r.events.filter((e) => e.type === "data");
		expect(data).toHaveLength(5);
		expect(r.out.stdout).toBe("é€");
	});

	it("failNextAttach reset breaks the stream after N bytes; resumableAttach recovers", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "printf 'abcdefghij'" }));
		fake.failNextAttach(m, 4, "reset");
		const seen: AgentAttachEvent[] = [];
		const err = await (async () => {
			for await (const ev of attachAll(m, r.commandId)) seen.push(ev);
		})().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as { code?: string }).code).toBe("ECONNRESET");
		expect(fake.attachFailures(m)).toBe(1);
		expect(
			dec.decode(
				new Uint8Array(
					seen.flatMap((e) => (e.type === "data" ? [...e.data] : [])),
				),
			),
		).toBe("abcd");

		// The next attach is healthy again; resumableAttach splices across a reset.
		fake.failNextAttach(m, 7, "reset");
		const parts: string[] = [];
		for await (const o of resumableAttach<AgentAttachEvent>({
			offsets: { stdout: 0n, stderr: 0n },
			open: (offsets, signal) =>
				fake.attach(
					m,
					{
						commandId: r.commandId,
						stdoutOffset: Number(offsets.stdout ?? 0n),
						stderrOffset: Number(offsets.stderr ?? 0n),
						ptyOffset: 0,
					},
					signal,
				),
			view: (ev) =>
				ev.type === "data"
					? {
							kind: "data",
							stream: ev.stream,
							offset: BigInt(ev.offset),
							data: ev.data,
						}
					: ev.type === "exit"
						? {
								kind: "exit",
								ends: {
									stdout: BigInt(ev.stdoutEnd),
									stderr: BigInt(ev.stderrEnd),
								},
							}
						: { kind: "other" },
		})) {
			if (o.type === "data") parts.push(dec.decode(o.data));
		}
		expect(parts.join("")).toBe("abcdefghij");
		expect(fake.attachFailures(m)).toBe(2);
	});

	it("an armed failure counts only once an attach reaches its byte count", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "printf abc" }));
		// The attach ends at exit before 100 bytes: the failure never bit.
		fake.failNextAttach(m, 100, "reset");
		await collect(attachAll(m, r.commandId));
		expect(fake.attachFailures(m)).toBe(0);
		fake.failNextAttach(m, 0, "unavailable");
		await collect(attachAll(m, r.commandId)).catch(() => {});
		expect(fake.attachFailures(m)).toBe(1);
		expect(fake.attachFailures("never-used")).toBe(0);
	});

	it("failNextAttach unavailable fails with AgentUnavailableError", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "printf abc" }));
		fake.failNextAttach(m, 0, "unavailable");
		const err = await collect(attachAll(m, r.commandId)).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AgentUnavailableError);
	});

	it("stops when the caller aborts", async () => {
		const m = newMachine();
		const commandId = await start(m, spec({ shell: "sleep 30" }));
		const ac = new AbortController();
		const p = collect(
			fake.attach(
				m,
				{ commandId, stdoutOffset: 0, stderrOffset: 0, ptyOffset: 0 },
				ac.signal,
			),
		).catch((e: unknown) => e);
		setTimeout(() => ac.abort(new Error("stop")), 50);
		expect(((await p) as Error).message).toBe("stop");
		await fake.kill(m, { commandId, graceMs: 0 });
	});
});

describe("input, PTY, signals", () => {
	it("sendInput dedupes by seq per input session; closeStdin ends input", async () => {
		const m = newMachine();
		const commandId = await start(m, spec({ shell: "cat", stdin: true }));
		const send = (session: string, seq: number, s: string, close = false) =>
			fake.sendInput(m, {
				commandId,
				inputSessionId: session,
				seq,
				data: enc.encode(s),
				closeStdin: close,
			});
		// Like the shim: an unknown session has last seq 0, so seq 0 is a repeat.
		expect(await send("s1", 0, "z")).toEqual({ applied: false });
		expect(await send("s1", 1, "a")).toEqual({ applied: true });
		expect(await send("s1", 1, "a")).toEqual({ applied: false });
		expect(await send("s1", 2, "b")).toEqual({ applied: true });
		expect(await send("s2", 1, "c")).toEqual({ applied: true });
		expect(await send("s1", 2, "b")).toEqual({ applied: false });
		await send("s1", 3, "", true);
		const r = await collect(attachAll(m, commandId));
		expect(r.out.stdout).toBe("abc");
		const late = await send("s1", 4, "x").catch((e: unknown) => e);
		expect((late as AgentCallError).code).toBe("command_exited");
	});

	it("a PTY command merges stdout and stderr into pty and records sizes", async () => {
		const m = newMachine();
		const commandId = await start(
			m,
			spec({
				shell: 'read line; echo "got $line"; echo oops >&2; echo $TERM',
				pty: { cols: 80, rows: 24, term: "xterm-256color" },
			}),
		);
		await fake.update(m, { commandId, cols: 120, rows: 40 });
		await fake.sendInput(m, {
			commandId,
			inputSessionId: "ws1",
			seq: 1,
			data: enc.encode("hello\n"),
			closeStdin: false,
		});
		const r = await collect(attachAll(m, commandId));
		expect(Object.keys(r.out)).toEqual(["pty"]);
		expect(r.out.pty).toBe("got hello\noops\nxterm-256color\n");
		expect(r.exit?.ptyEnd).toBe(r.out.pty?.length);
		expect(fake.ptySizes(commandId)).toEqual([
			{ cols: 80, rows: 24 },
			{ cols: 120, rows: 40 },
		]);
		const info = await fake.get(m, commandId);
		expect(Object.keys(info.streams)).toEqual(["pty"]);
		const late = await fake
			.update(m, { commandId, cols: 1, rows: 1 })
			.catch((e: unknown) => e);
		expect((late as AgentCallError).code).toBe("command_exited");
	});

	it("kill: SIGTERM to the group, then status killed", async () => {
		const m = newMachine();
		const commandId = await start(m, spec({ shell: "sleep 30" }));
		const info = await fake.kill(m, { commandId, graceMs: 2000 });
		expect(info.commandId).toBe(commandId);
		const r = await collect(attachAll(m, commandId));
		expect(r.exit).toMatchObject({
			status: "killed",
			signal: "SIGTERM",
			code: 143,
			reason: "signal",
		});
		// Kill and Signal of an exited command return its info.
		expect((await fake.kill(m, { commandId })).state).toBe("exited");
		expect((await fake.signal(m, { commandId, signal: "INT" })).state).toBe(
			"exited",
		);
	});

	it("signal by short name and number", async () => {
		const m = newMachine();
		const commandId = await start(m, spec({ shell: "sleep 30" }));
		await fake.signal(m, { commandId, signal: "INT" });
		const r = await collect(attachAll(m, commandId));
		expect(r.exit).toMatchObject({ status: "killed", signal: "SIGINT" });
		const c2 = await start(m, spec({ shell: "sleep 30" }));
		await fake.signal(m, { commandId: c2, signal: "9" });
		expect((await collect(attachAll(m, c2))).exit?.signal).toBe("SIGKILL");
		const bad = await fake
			.signal(m, { commandId: c2, signal: "SIGNOPE" })
			.catch((e: unknown) => e);
		expect((bad as AgentCallError).code).toBe("invalid_argument");
	});

	it("signal exit codes use the Linux numbers (SIGUSR1 = 10 → 138), and a number is a Linux signal", async () => {
		const m = newMachine();
		const c1 = await start(m, spec({ shell: "sleep 30" }));
		await fake.signal(m, { commandId: c1, signal: "SIGUSR1" });
		expect((await collect(attachAll(m, c1))).exit).toMatchObject({
			status: "killed",
			signal: "SIGUSR1",
			code: 138,
		});
		const c2 = await start(m, spec({ shell: "sleep 30" }));
		await fake.signal(m, { commandId: c2, signal: "12" });
		expect((await collect(attachAll(m, c2))).exit).toMatchObject({
			signal: "SIGUSR2",
			code: 140,
		});
	});

	it("truncateOutput simulates output dropped by a full disk (output_truncated)", async () => {
		const m = newMachine();
		const commandId = await start(m, spec({ shell: "echo hi" }));
		fake.truncateOutput(commandId, "disk_full");
		const r = await collect(attachAll(m, commandId));
		expect(r.exit).toMatchObject({ outputTruncated: "disk_full" });
		expect((await fake.get(m, commandId)).outputTruncated).toBe("disk_full");
		const other = await run(m, spec({ shell: "true" }));
		expect(other.exit).toMatchObject({ outputTruncated: null });
	});

	it("writePastEnd: size grows past the end, attach stops at the end", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "printf abc" }));
		fake.writePastEnd(r.commandId, "stdout", "LEFT");
		const info = await fake.get(m, r.commandId);
		expect(info.streams.stdout).toEqual({ size: 7, availableFrom: 0, end: 3 });
		const all = await collect(attachAll(m, r.commandId));
		expect(all.out.stdout).toBe("abc");
		expect(all.exit).toMatchObject({ stdoutEnd: 3 });
		const tail = await collect(attachAll(m, r.commandId, {}, { tailBytes: 2 }));
		expect(tail.out.stdout).toBe("bc");
	});

	it("failNextStart: refused before the launch, or failing after it", async () => {
		const m = newMachine();
		fake.failNextStart(m, "invalid_argument");
		const id = randomUUID();
		const s = spec({ shell: "true" });
		await expect(
			fake.start(m, { commandId: id, spec: s }, { requestId: "r" }),
		).rejects.toMatchObject({
			name: "AgentCallError",
			code: "invalid_argument",
		});
		expect(fake.startCount(id, m)).toBe(0);
		fake.failNextStart(m, "internal", { launched: true });
		await expect(
			fake.start(m, { commandId: id, spec: s }, { requestId: "r" }),
		).rejects.toMatchObject({ code: "internal" });
		const again = await fake.start(
			m,
			{ commandId: id, spec: s },
			{ requestId: "r" },
		);
		expect(again.created).toBe(false);
		expect(fake.startCount(id, m)).toBe(1);
	});

	it("timeoutMs: SIGTERM like the shim, reason timeout", async () => {
		const m = newMachine();
		const r = await run(m, spec({ shell: "sleep 30", timeoutMs: 100 }));
		expect(r.exit).toMatchObject({
			status: "killed",
			reason: "timeout",
			signal: "SIGTERM",
			code: 143,
		});
	});
});

describe("faults and capabilities", () => {
	it("setUnavailable makes every call fail with AgentUnavailableError", async () => {
		const m = newMachine();
		fake.setUnavailable(m, true);
		try {
			await expect(
				fake.start(
					m,
					{ commandId: randomUUID(), spec: spec({ shell: "true" }) },
					{ requestId: "r" },
				),
			).rejects.toBeInstanceOf(AgentUnavailableError);
			await expect(fake.files(m, "?path=x", {})).rejects.toBeInstanceOf(
				AgentUnavailableError,
			);
			await expect(fake.stat(m, { path: "~" })).rejects.toBeInstanceOf(
				AgentUnavailableError,
			);
			await expect(
				fake.requireCapability(m, "process.v1"),
			).rejects.toBeInstanceOf(AgentUnavailableError);
		} finally {
			fake.setUnavailable(m, false);
		}
		expect((await fake.stat(m, { path: "~" })).type).toBe("dir");
	});

	it("an open attach breaks when the machine becomes unavailable", async () => {
		const m = newMachine();
		fake.heartbeatMs = 20;
		const commandId = await start(m, spec({ shell: "sleep 30" }));
		const p = collect(attachAll(m, commandId)).catch((e: unknown) => e);
		setTimeout(() => fake.setUnavailable(m, true), 50);
		const err = await p;
		fake.setUnavailable(m, false);
		expect((err as { code?: string }).code).toBe("ECONNRESET");
		await fake.kill(m, { commandId, graceMs: 0 });
	});

	it("capabilities are configurable per machine", async () => {
		const m = newMachine();
		expect(await fake.capabilities(m)).toContain("files.archive.v1");
		// The full set of the real agent (guest-agent internal/agent/info.go).
		expect(await fake.capabilities(m)).toContain("system.activity.v1");
		await fake.requireCapability(m, "process.pty");
		fake.machine(m).capabilities = ["process.v1"];
		const err = await fake
			.requireCapability(m, "process.pty")
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AgentOutdatedError);
		expect((err as AgentOutdatedError).capability).toBe("process.pty");
	});

	it("listPorts, updateEnv and updateSecrets", async () => {
		const m = newMachine();
		expect(await fake.listPorts(m)).toEqual([]);
		fake.machine(m).ports = [
			{
				port: 3000,
				addresses: ["0.0.0.0"],
				pid: 1,
				process: "node",
				user: "u",
			},
		];
		expect((await fake.listPorts(m))[0]?.port).toBe(3000);
		expect(await fake.updateEnv(m, { A: "1" }, "r1")).toEqual({ ready: true });
		await fake.updateSecrets(
			m,
			{
				secretEnv: { S: "2" },
				secretFiles: [
					{ name: "k", content: enc.encode("x"), mode: 0o600, linkPath: "" },
				],
			},
			"r2",
		);
		expect(fake.machine(m).secretFiles.map((f) => f.name)).toEqual(["k"]);
		const r = await run(m, spec({ shell: 'printf "$A$S"' }));
		expect(r.out.stdout).toBe("12");
	});

	it("close kills processes and removes the temporary directories", async () => {
		const f = new FakeAgent();
		const m = randomUUID();
		const home = f.machine(m).home;
		const res = await f.start(
			m,
			{ commandId: "c", spec: spec({ shell: "sleep 30 & sleep 30; wait" }) },
			{ requestId: "r" },
		);
		const pid = res.command.pid as number;
		expect(pidAlive(pid)).toBe(true);
		await f.close();
		expect(pidAlive(pid)).toBe(false);
		// The background sleep in the same process group is gone too.
		const pgrep = spawnSync("pgrep", ["-g", String(pid)]);
		expect(pgrep.stdout.toString().trim()).toBe("");
		expect(existsSync(home)).toBe(false);
	});
});

describe("files HTTP", () => {
	async function put(m: string, path: string, body: string) {
		const res = await fake.files(m, `?path=${encodeURIComponent(path)}`, {
			method: "PUT",
			body,
		});
		expect(res.status).toBe(200);
		return parseAgentFileInfo(await res.json());
	}

	it("PUT writes atomically and returns FileInfo; GET reads it back", async () => {
		const m = newMachine();
		const info = await put(m, "dir/a.txt", "hello world");
		expect(info).toMatchObject({
			path: "/home/user/dir/a.txt",
			name: "a.txt",
			type: "file",
			size: 11,
			mode: 0o644,
		});
		const res = await fake.files(m, "?path=dir%2Fa.txt", {});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("accept-ranges")).toBe("bytes");
		expect(res.headers.get("content-length")).toBe("11");
		expect(res.headers.get("etag")).toMatch(/^"\d+-11-\d+"$/);
		expect(res.headers.get("last-modified")).toBeTruthy();
		expect(await res.text()).toBe("hello world");
	});

	it("Range, If-Range and HEAD", async () => {
		const m = newMachine();
		await put(m, "r.txt", "0123456789");
		const full = await fake.files(m, "?path=r.txt", {});
		const etag = full.headers.get("etag") as string;
		await full.body?.cancel();

		const part = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=2-5" },
		});
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await part.text()).toBe("2345");

		const suffix = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=-3" },
		});
		expect(await suffix.text()).toBe("789");
		const open = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=7-" },
		});
		expect(await open.text()).toBe("789");

		const ok = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=5-", "If-Range": etag },
		});
		expect(ok.status).toBe(206);
		await ok.body?.cancel();
		const stale = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=5-", "If-Range": '"1-2-3"' },
		});
		expect(stale.status).toBe(200);
		expect(await stale.text()).toBe("0123456789");

		const multi = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=0-1,4-5" },
		});
		expect(multi.status).toBe(200);
		await multi.body?.cancel();

		const bad = await fake.files(m, "?path=r.txt", {
			headers: { Range: "bytes=50-60" },
		});
		expect(bad.status).toBe(416);
		expect(bad.headers.get("content-range")).toBe("bytes */10");
		await bad.body?.cancel();

		const head = await fake.files(m, "?path=r.txt", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("10");
		expect(await head.text()).toBe("");
	});

	it("guest paths stay inside the machine root", async () => {
		const f = new FakeAgent();
		try {
			const m = randomUUID();
			const root = f.machine(m).root;
			const name = `sbx-fake-${randomUUID()}`;
			const res = await f.files(
				m,
				`?path=${encodeURIComponent(`/tmp/${name}`)}`,
				{
					method: "PUT",
					body: "x",
				},
			);
			expect(parseAgentFileInfo(await res.json()).path).toBe(`/tmp/${name}`);
			expect(existsSync(join(root, "tmp", name))).toBe(true);
			expect(existsSync(join("/tmp", name))).toBe(false);
			expect((await f.stat(m, { path: `/tmp/${name}` })).size).toBe(1);

			// Guest /etc/passwd is not the host's.
			const inside = await f.files(m, "?path=..%2F..%2Fetc%2Fpasswd", {});
			expect((await agentHttpError(inside)).code).toBe("path_not_found");
			for (const p of [
				"../../../etc/passwd",
				"/../etc/passwd",
				"~/../../../x",
			]) {
				const out = await f.files(m, `?path=${encodeURIComponent(p)}`, {});
				expect((await agentHttpError(out)).code).toBe("invalid_path");
				const rpc = await f.stat(m, { path: p }).catch((e: unknown) => e);
				expect((rpc as AgentCallError).code).toBe("invalid_path");
			}
			const rm = await f
				.remove(m, { path: "../../..", recursive: true, requestId: "r" })
				.catch((e: unknown) => e);
			expect((rm as AgentCallError).code).toBe("invalid_path");

			// A symlink that leaves the root is not followed.
			symlinkSync(tmpdir(), join(f.machine(m).home, "out"));
			const via = await f.files(m, "?path=out%2Fx", {
				method: "PUT",
				body: "x",
			});
			expect((await agentHttpError(via)).code).toBe("invalid_path");
			const link = await f.stat(m, { path: "out", noFollow: true });
			expect(link.type).toBe("symlink");
			expect(
				(
					(await f
						.list(m, { path: "out" })
						.catch((e: unknown) => e)) as AgentCallError
				).code,
			).toBe("invalid_path");
			await f.close();
			expect(existsSync(root)).toBe(false);
		} finally {
			await f.close();
		}
	});

	it("errors: missing file, directory, empty path, unknown endpoint", async () => {
		const m = newMachine();
		const missing = await fake.files(m, "?path=nope", {});
		expect(missing.status).toBe(404);
		expect((await agentHttpError(missing)).code).toBe("path_not_found");
		const dir = await fake.files(m, "?path=~", {});
		expect(dir.status).toBe(400);
		expect((await agentHttpError(dir)).code).toBe("is_directory");
		const empty = await fake.files(m, "", {});
		expect((await agentHttpError(empty)).code).toBe("invalid_path");
		const unknown = await fake.files(m, "/nope", {});
		expect(unknown.status).toBe(404);
		await unknown.body?.cancel();
	});

	it("PUT with overwrite=false and make_parents=false", async () => {
		const m = newMachine();
		await put(m, "x.txt", "1");
		const exists = await fake.files(m, "?path=x.txt&overwrite=false", {
			method: "PUT",
			body: "2",
		});
		expect(exists.status).toBe(409);
		expect((await agentHttpError(exists)).code).toBe("already_exists");
		const noParent = await fake.files(m, "?path=a%2Fb%2Fc&make_parents=false", {
			method: "PUT",
			body: "2",
		});
		expect((await agentHttpError(noParent)).code).toBe("path_not_found");
		const mode = await fake.files(m, "?path=y.sh&mode=755", {
			method: "PUT",
			body: "#!/bin/sh",
		});
		expect(parseAgentFileInfo(await mode.json()).mode).toBe(0o755);
	});

	it("chunked upload: wrong offset → 409 with Sbx-Upload-Offset; HEAD; commit idempotent", async () => {
		const m = newMachine();
		const id = "upl_1";
		const chunk = (offset: number, body: string) =>
			fake.files(m, `/uploads/${id}?offset=${offset}&path=big.bin`, {
				method: "PUT",
				body,
			});
		const notStarted = await chunk(5, "x");
		expect(notStarted.status).toBe(409);
		expect(notStarted.headers.get("sbx-upload-offset")).toBe("0");
		await notStarted.body?.cancel();

		const c1 = await chunk(0, "hello ");
		expect(c1.status).toBe(200);
		expect(await c1.json()).toEqual({ offset: 6 });
		const wrong = await chunk(3, "zzz");
		expect(wrong.status).toBe(409);
		expect(wrong.headers.get("sbx-upload-offset")).toBe("6");
		const werr = await agentHttpError(wrong);
		expect(werr.code).toBe("upload_offset_mismatch");
		expect(werr.details).toEqual({ offset: 6 });

		const head = await fake.files(m, `/uploads/${id}`, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("sbx-upload-offset")).toBe("6");
		expect((await chunk(6, "world")).status).toBe(200);

		const body = JSON.stringify({
			path: "out/big.bin",
			sha256: sha256("hello world"),
			mode: 0o600,
		});
		const commit = await fake.files(m, `/uploads/${id}/commit`, {
			method: "POST",
			body,
		});
		expect(commit.status).toBe(200);
		const committed = await commit.text();
		const info = parseAgentFileInfo(JSON.parse(committed));
		expect(info).toMatchObject({ name: "big.bin", size: 11, mode: 0o600 });
		expect(
			readFileSync(join(fake.machine(m).home, "out/big.bin"), "utf8"),
		).toBe("hello world");
		const again = await fake.files(m, `/uploads/${id}/commit`, {
			method: "POST",
			body,
		});
		expect(await again.text()).toBe(committed);
	});

	it("commit with a wrong sha256 → 422 checksum_mismatch and the upload is gone", async () => {
		const m = newMachine();
		const id = "upl_2";
		await fake.files(m, `/uploads/${id}?offset=0`, {
			method: "PUT",
			body: "data",
		});
		const res = await fake.files(m, `/uploads/${id}/commit`, {
			method: "POST",
			body: JSON.stringify({ path: "d.bin", sha256: sha256("other") }),
		});
		expect(res.status).toBe(422);
		expect((await agentHttpError(res)).code).toBe("checksum_mismatch");
		const head = await fake.files(m, `/uploads/${id}`, { method: "HEAD" });
		expect(head.status).toBe(404);
		expect(existsSync(join(fake.machine(m).home, "d.bin"))).toBe(false);
	});

	it("chunk over the limit → 413; DELETE cancels; unknown upload → upload_not_found", async () => {
		const f = new FakeAgent({ maxChunkBytes: 4 });
		try {
			const m = randomUUID();
			const big = await f.files(m, "/uploads/u?offset=0", {
				method: "PUT",
				body: "12345",
			});
			expect(big.status).toBe(413);
			expect((await agentHttpError(big)).code).toBe("payload_too_large");
			await f.files(m, "/uploads/u?offset=0", { method: "PUT", body: "1234" });
			const del = await f.files(m, "/uploads/u", { method: "DELETE" });
			expect(del.status).toBe(204);
			const gone = await f.files(m, "/uploads/u/commit", {
				method: "POST",
				body: JSON.stringify({ path: "x" }),
			});
			expect((await agentHttpError(gone)).code).toBe("upload_not_found");
		} finally {
			await f.close();
		}
	});
});

describe("files archive", () => {
	function tree(root: string): Record<string, string> {
		const out: Record<string, string> = {};
		const r = spawnSync("find", [".", "-mindepth", "1"], { cwd: root });
		for (const rel of r.stdout.toString().trim().split("\n").sort()) {
			const p = join(root, rel);
			const st = lstatSync(p);
			out[rel] = st.isSymbolicLink()
				? `link:${spawnSync("readlink", [p]).stdout.toString().trim()}`
				: st.isDirectory()
					? `dir:${(st.mode & 0o777).toString(8)}`
					: `file:${(st.mode & 0o777).toString(8)}:${sha256(readFileSync(p))}`;
		}
		return out;
	}

	async function bytes(res: Response): Promise<Uint8Array<ArrayBuffer>> {
		return new Uint8Array(await res.arrayBuffer());
	}

	for (const format of ["tar", "tar.gz"]) {
		it(`GET then PUT round trip (${format})`, async () => {
			const m = newMachine();
			const home = fake.machine(m).home;
			mkdirSync(join(home, "src/a/b"), { recursive: true });
			writeFileSync(join(home, "src/top.txt"), "top");
			writeFileSync(join(home, "src/a/b/deep.bin"), Buffer.alloc(70_000, 7));
			writeFileSync(join(home, "src/run.sh"), "#!/bin/sh", { mode: 0o755 });
			symlinkSync("top.txt", join(home, "src/link"));
			const get = await fake.files(m, `/archive?path=src&format=${format}`, {});
			expect(get.status).toBe(200);
			expect(get.headers.get("content-type")).toBe(
				format === "tar" ? "application/x-tar" : "application/gzip",
			);
			const archive = await bytes(get);
			const putRes = await fake.files(m, `/archive?path=dst&format=${format}`, {
				method: "PUT",
				body: archive,
			});
			expect(putRes.status).toBe(200);
			const result = (await putRes.json()) as Record<string, unknown>;
			expect(result).toEqual({
				path: "/home/user/dst",
				entries: 6,
				size: 3 + 70_000 + 9,
			});
			expect(tree(join(home, "dst"))).toEqual(tree(join(home, "src")));
		});
	}

	it("GET of a file is not_directory", async () => {
		const m = newMachine();
		writeFileSync(join(fake.machine(m).home, "f"), "x");
		const res = await fake.files(m, "/archive?path=f", {});
		expect(res.status).toBe(400);
		expect((await agentHttpError(res)).code).toBe("not_directory");
	});

	const gzip = (b: Uint8Array) => new Uint8Array(gzipSync(b));

	const hostile: [string, Uint8Array<ArrayBuffer>][] = [
		["dot-dot", tarOf(tarEntry("../evil", "0", "x"))],
		["nested dot-dot", tarOf(tarEntry("a/../../evil", "0", "x"))],
		["absolute", tarOf(tarEntry("/tmp/evil", "0", "x"))],
		["hardlink outside", tarOf(tarEntry("h", "1", "", "/etc/passwd"))],
		["hardlink to unknown", tarOf(tarEntry("h", "1", "", "missing"))],
		["fifo", tarOf(tarEntry("p", "6"))],
		["char device", tarOf(tarEntry("c", "3"))],
		[
			"through an archived symlink",
			tarOf(tarEntry("l", "2", "", "/tmp"), tarEntry("l/evil", "0", "x")),
		],
	];
	for (const [name, archive] of hostile) {
		it(`PUT rejects ${name} with invalid_path, writing nothing`, async () => {
			const m = newMachine();
			const res = await fake.files(m, "/archive?path=dst", {
				method: "PUT",
				body: archive,
			});
			expect(res.status).toBe(400);
			const err = await agentHttpError(res);
			expect(err.code).toBe("invalid_path");
			expect(err.details).toEqual({ entriesWritten: 0 });
			expect(existsSync(join(fake.machine(m).home, "evil"))).toBe(false);
		});
	}

	it("PUT rejects a write through a symlink already on disk", async () => {
		const m = newMachine();
		const home = fake.machine(m).home;
		mkdirSync(join(home, "dst"));
		mkdirSync(join(home, "outside"));
		symlinkSync(join(home, "outside"), join(home, "dst/l"));
		const res = await fake.files(m, "/archive?path=dst", {
			method: "PUT",
			body: tarOf(tarEntry("l/evil", "0", "x")),
		});
		expect((await agentHttpError(res)).code).toBe("invalid_path");
		expect(existsSync(join(home, "outside/evil"))).toBe(false);
	});

	it("PUT with overwrite=false refuses an existing file; hardlinks inside work", async () => {
		const m = newMachine();
		const home = fake.machine(m).home;
		mkdirSync(join(home, "dst"));
		writeFileSync(join(home, "dst/f"), "old");
		const refused = await fake.files(m, "/archive?path=dst&overwrite=false", {
			method: "PUT",
			body: tarOf(tarEntry("f", "0", "new")),
		});
		expect((await agentHttpError(refused)).code).toBe("already_exists");
		expect(readFileSync(join(home, "dst/f"), "utf8")).toBe("old");

		const ok = await fake.files(m, "/archive?path=dst", {
			method: "PUT",
			body: gzip(tarOf(tarEntry("g", "0", "new"), tarEntry("h", "1", "", "g"))),
		});
		expect(ok.status).toBe(400); // gzip body without format=tar.gz
		await ok.body?.cancel();
		const ok2 = await fake.files(m, "/archive?path=dst&format=tar.gz", {
			method: "PUT",
			body: gzip(tarOf(tarEntry("g", "0", "new"), tarEntry("h", "1", "", "g"))),
		});
		expect(await ok2.json()).toEqual({
			path: "/home/user/dst",
			entries: 2,
			size: 3,
		});
		expect(readFileSync(join(home, "dst/h"), "utf8")).toBe("new");
	});

	it("PUT drops setuid and setgid from archived modes", async () => {
		const m = newMachine();
		const res = await fake.files(m, "/archive?path=dst", {
			method: "PUT",
			body: tarOf(
				tarEntry("s", "0", "x", "", 0o4755),
				tarEntry("g", "0", "x", "", 0o2750),
				tarEntry("d", "5", "", "", 0o2775),
			),
		});
		expect(res.status).toBe(200);
		const mode = (p: string) =>
			lstatSync(join(fake.machine(m).home, "dst", p)).mode & 0o7777;
		expect([mode("s"), mode("g"), mode("d")]).toEqual([0o755, 0o750, 0o775]);
	});

	it("PUT over the entry limit → 413 payload_too_large", async () => {
		const f = new FakeAgent({ archiveMaxEntries: 2 });
		try {
			const m = randomUUID();
			const res = await f.files(m, "/archive?path=dst", {
				method: "PUT",
				body: tarOf(
					tarEntry("a", "0", "1"),
					tarEntry("b", "0", "2"),
					tarEntry("c", "0", "3"),
				),
			});
			expect(res.status).toBe(413);
			expect((await agentHttpError(res)).code).toBe("payload_too_large");
		} finally {
			await f.close();
		}
	});
});

describe("Filesystem RPC", () => {
	it("stat, list with depth and paging, hidden files", async () => {
		const m = newMachine();
		const home = fake.machine(m).home;
		mkdirSync(join(home, "d/e"), { recursive: true });
		writeFileSync(join(home, "d/a.txt"), "aa");
		writeFileSync(join(home, "d/.hidden"), "");
		writeFileSync(join(home, "d/e/f.txt"), "f");
		symlinkSync("a.txt", join(home, "d/link"));

		const st = await fake.stat(m, { path: "d/a.txt" });
		expect(st).toMatchObject({ type: "file", size: 2, name: "a.txt" });
		expect(st.mtime).toBeInstanceOf(Date);
		expect((await fake.stat(m, { path: "d/link" })).type).toBe("file");
		const link = await fake.stat(m, { path: "d/link", noFollow: true });
		expect(link).toMatchObject({ type: "symlink", symlinkTarget: "a.txt" });

		const names = (r: { entries: { path: string }[] }) =>
			r.entries.map((e) => e.path.slice("/home/user/d/".length));
		expect(names(await fake.list(m, { path: "d" }))).toEqual([
			".hidden",
			"a.txt",
			"e",
			"link",
		]);
		expect(
			names(await fake.list(m, { path: "d", depth: 2, includeHidden: false })),
		).toEqual(["a.txt", "e", "e/f.txt", "link"]);
		const p1 = await fake.list(m, { path: "d", depth: 2, pageSize: 2 });
		expect(names(p1)).toEqual([".hidden", "a.txt"]);
		const p2 = await fake.list(m, {
			path: "d",
			depth: 2,
			pageSize: 2,
			pageToken: p1.nextPageToken,
		});
		expect(names(p2)).toEqual(["e", "e/f.txt"]);
		const p3 = await fake.list(m, {
			path: "d",
			depth: 2,
			pageSize: 2,
			pageToken: p2.nextPageToken,
		});
		expect(names(p3)).toEqual(["link"]);
		expect(p3.nextPageToken).toBe("");

		const notDir = await fake
			.list(m, { path: "d/a.txt" })
			.catch((e: unknown) => e);
		expect((notDir as AgentCallError).code).toBe("not_directory");
		const missing = await fake
			.stat(m, { path: "nope" })
			.catch((e: unknown) => e);
		expect((missing as AgentCallError).code).toBe("path_not_found");
		const deep = await fake
			.list(m, { path: "d", depth: 9 })
			.catch((e: unknown) => e);
		expect((deep as AgentCallError).code).toBe("invalid_argument");
	});

	it("makeDir, move, chmod, remove", async () => {
		const m = newMachine();
		const home = fake.machine(m).home;
		const r = "req";
		const made = await fake.makeDir(m, {
			path: "x/y",
			parents: true,
			requestId: r,
		});
		expect(made.created).toBe(true);
		expect(made.info.type).toBe("dir");
		expect(
			(await fake.makeDir(m, { path: "x/y", parents: true, requestId: r }))
				.created,
		).toBe(false);
		const noParent = await fake
			.makeDir(m, { path: "p/q", requestId: r })
			.catch((e: unknown) => e);
		expect((noParent as AgentCallError).code).toBe("path_not_found");

		writeFileSync(join(home, "x/f"), "1");
		writeFileSync(join(home, "x/g"), "2");
		const moved = await fake.move(m, {
			src: "x/f",
			dst: "x/y/f",
			requestId: r,
		});
		expect(moved.path).toBe("/home/user/x/y/f");
		const clash = await fake
			.move(m, { src: "x/g", dst: "x/y/f", overwrite: false, requestId: r })
			.catch((e: unknown) => e);
		expect((clash as AgentCallError).code).toBe("already_exists");

		const ch = await fake.chmod(m, { path: "x/g", mode: 0o600, requestId: r });
		expect(ch.mode).toBe(0o600);

		const notEmpty = await fake
			.remove(m, { path: "x", requestId: r })
			.catch((e: unknown) => e);
		expect(notEmpty).toBeInstanceOf(AgentCallError);
		expect(
			await fake.remove(m, { path: "x", recursive: true, requestId: r }),
		).toEqual({ existed: true });
		expect(await fake.remove(m, { path: "x", requestId: r })).toEqual({
			existed: false,
		});
	});
});
