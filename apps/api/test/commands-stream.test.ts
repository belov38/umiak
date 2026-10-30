// mode: stream and /stream (S7 §9.5, §9.7): output byte for byte across
// agent reconnects, `error agent_unavailable` with offsets when the agent
// is gone, reattach from those offsets, UTF-8 split between agent chunks
// (Review Focus 3), heartbeats and the max duration.
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type AgentApi, AgentCallError, type Frame } from "../src/index.ts";
import {
	type Any,
	bytesOf,
	openStream,
	type ReadySandbox,
	readySandbox,
	sha256,
	shellGate,
	until,
	WAIT_MS,
} from "./helpers/commands.ts";
import type { Harness } from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const LINES = 3000;
const LINE = 512;

/** 3000 lines of 512 bytes: 511 digits of the line number and "\n". */
function expectedLines(n = LINES): Buffer {
	const parts: string[] = [];
	for (let i = 1; i <= n; i++)
		parts.push(`${String(i).padStart(LINE - 1, "0")}\n`);
	return Buffer.from(parts.join(""));
}

const LINES_CMD = `for i in $(seq 1 ${LINES}); do printf '%0${LINE - 1}d\\n' $i; done; echo tail >&2`;

const commandIdOf = (frames: Frame[]) =>
	(frames.find((f) => f.type === "started") as Any).commandId as string;

describe.skipIf(skipPg())("command streams", () => {
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
	afterEach(() => {
		w.agent.chunkSize = 64 * 1024;
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const stream = (json: Record<string, unknown>, harness = h) =>
		openStream(harness, "POST", sb.commands, {
			json: { mode: "stream", ...json },
		});

	it("3000 lines x 512 B arrive byte for byte; exit offsets are the sizes", async () => {
		const s = await stream({ command: LINES_CMD });
		const frames = await s.rest();
		const out = bytesOf(frames);
		expect(out.stdout.length).toBe(LINES * LINE);
		expect(sha256(out.stdout)).toBe(sha256(expectedLines()));
		expect(out.stderr.toString()).toBe("tail\n");
		expect(frames.at(-1)).toMatchObject({
			type: "exit",
			status: "exited",
			stdoutOffset: LINES * LINE,
			stderrOffset: 5,
		});
		for (const f of frames) {
			if (f.type === "stdout")
				expect(f.nextOffset - f.offset).toBeLessThanOrEqual(64 * 1024);
		}
	});

	it("an attach reset in the middle: the same sha256, one Start", async () => {
		w.agent.failNextAttach(sb.machineId, 100_000, "reset");
		const s = await stream({ command: LINES_CMD });
		const frames = await s.rest();
		expect(sha256(bytesOf(frames).stdout)).toBe(sha256(expectedLines()));
		expect(frames.at(-1)?.type).toBe("exit");
		expect(frames.some((f) => f.type === "error")).toBe(false);
		const id = commandIdOf(frames).slice(4).toUpperCase();
		expect(w.agent.startCount(id, sb.machineId)).toBe(1);
	});

	it("the agent gone past the budget: last frame error agent_unavailable with offsets; reattach completes it", async () => {
		w.agent.failNextAttach(sb.machineId, 150_001, "unavailable");
		const s = await stream({ command: `${LINES_CMD}; sleep 0.2` });
		const frames = await s.rest();
		const last = frames.at(-1) as Any;
		expect(last).toMatchObject({
			type: "error",
			code: "agent_unavailable",
			retryable: true,
			stdoutOffset: expect.any(Number),
			stderrOffset: expect.any(Number),
		});
		expect(last.requestId).toBe(s.headers.get("request-id"));
		expect(last.ptyOffset).toBeUndefined();
		// The fake counts data bytes of both streams. When the attach lags
		// behind the command (a loaded machine), stderr "tail\n" may come
		// before the budget is reached: the split between the streams is
		// timing, their sum and the delivered bytes are not.
		expect(last.stdoutOffset + last.stderrOffset).toBe(150_001);
		const head = bytesOf(frames);
		expect(head.stdout.length).toBe(last.stdoutOffset);
		expect(head.stderr.length).toBe(last.stderrOffset);

		const id = commandIdOf(frames);
		const again = await openStream(
			h,
			"GET",
			`${sb.commands}/${id}/stream?stdoutOffset=${last.stdoutOffset}&stderrOffset=${last.stderrOffset}`,
		);
		expect(again.status).toBe(200);
		const rest = await again.rest();
		expect(rest[0]).toMatchObject({
			type: "attached",
			commandId: id,
			stdoutOffset: last.stdoutOffset,
			stderrOffset: last.stderrOffset,
			encoding: "utf8",
		});
		const tail = bytesOf(rest, "utf8", {
			stdout: last.stdoutOffset,
			stderr: last.stderrOffset,
		});
		expect(sha256(Buffer.concat([head.stdout, tail.stdout]))).toBe(
			sha256(expectedLines()),
		);
		expect(Buffer.concat([head.stderr, tail.stderr]).toString()).toBe("tail\n");
		expect(rest.at(-1)?.type).toBe("exit");
	});

	describe("UTF-8 across agent chunks (Review Focus 3)", () => {
		const TEXT = "a€😀é z — ✓\n".repeat(20);

		it("one byte per agent event: frames carry whole characters, offsets on boundaries", async () => {
			w.agent.chunkSize = 1;
			const s = await stream({ command: `printf '%s' '${TEXT}'` });
			const frames = await s.rest();
			const data = frames.filter((f) => f.type === "stdout") as Any[];
			expect(data.map((f) => f.data).join("")).toBe(TEXT);
			const bytes = Buffer.from(TEXT);
			for (const f of data) {
				expect(f.data).not.toContain("�");
				expect(Buffer.byteLength(f.data)).toBe(f.nextOffset - f.offset);
				expect(bytes.subarray(f.offset, f.nextOffset).toString()).toBe(f.data);
			}
		});

		it("a break after half a character: offsets stop before it; reattach gives the same text", async () => {
			w.agent.chunkSize = 1;
			// "a" (1) then "€" (3 bytes): the agent stops after "a" and one byte of "€".
			w.agent.failNextAttach(sb.machineId, 2, "unavailable");
			const s = await stream({ command: `sleep 0.2; printf '%s' '${TEXT}'` });
			const frames = await s.rest();
			const last = frames.at(-1) as Any;
			expect(last).toMatchObject({ type: "error", stdoutOffset: 1 });
			expect(
				frames.filter((f) => f.type === "stdout").map((f: Any) => f.data),
			).toEqual(["a"]);
			const again = await openStream(
				h,
				"GET",
				`${sb.commands}/${commandIdOf(frames)}/stream?stdoutOffset=1&stderrOffset=${last.stderrOffset}`,
			);
			const rest = await again.rest();
			const text = rest
				.filter((f) => f.type === "stdout")
				.map((f: Any) => f.data)
				.join("");
			expect(`a${text}`).toBe(TEXT);
		});

		it("base64: exactly the bytes [offset, nextOffset), also one byte per event", async () => {
			w.agent.chunkSize = 1;
			const s = await stream({
				command: "printf '\\342\\202'; printf '\\254\\377'",
				encoding: "base64",
			});
			const frames = await s.rest();
			expect(frames[0]).toMatchObject({ type: "started", encoding: "base64" });
			expect(bytesOf(frames, "base64").stdout).toEqual(
				Buffer.from([0xe2, 0x82, 0xac, 0xff]),
			);
		});

		it("invalid bytes become U+FFFD; offsets count the source bytes", async () => {
			const s = await stream({ command: "printf 'x\\377y\\342\\202'" });
			const frames = await s.rest();
			const data = frames.filter((f) => f.type === "stdout") as Any[];
			expect(data.map((f) => f.data).join("")).toBe("x�y�");
			expect(data.at(-1).nextOffset).toBe(5);
			expect(frames.at(-1)).toMatchObject({ type: "exit", stdoutOffset: 5 });
		});
	});

	describe("when the agent attach fails for good", () => {
		const timings = {
			readyWaitMs: 1000,
			heartbeatMs: 15_000,
			maxDurationMs: 60_000,
			attachMaxAttempts: 3,
		};

		/** Replaces attach for one machine; returns the restore function. */
		function patchAttach(
			machineId: string,
			impl: AgentApi["attach"],
		): () => void {
			const real = w.agent.attach.bind(w.agent);
			w.agent.attach = ((m, req, signal) =>
				m === machineId
					? impl(m, req, signal)
					: real(m, req, signal)) as typeof w.agent.attach;
			return () => {
				w.agent.attach = real;
			};
		}

		it("resumableAttach gives up without progress: error agent_unavailable, retryable, with offsets", async () => {
			const s = await readySandbox(w);
			const fast = w.harness({ deps: { commandTimings: timings } });
			const start = await fast.request("POST", s.commands, {
				json: { command: "printf abc; sleep 30", mode: "detached" },
			});
			const id = (start.body as Any).id;
			// The output exists before the agent is "lost" (the retry reads it).
			await until(async () => {
				const g = await fast.request("GET", `${s.commands}/${id}`);
				return (g.body as Any).streams.stdout.sizeBytes === 3;
			});
			let opens = 0;
			// Every attach ends at once without exit: no progress, reopened.
			const restore = patchAttach(s.machineId, async function* () {
				opens++;
				yield* [];
			});
			try {
				const r = await fast.request(
					"GET",
					`${s.commands}/${id}/stream?stdoutOffset=2&stderrOffset=0`,
				);
				const frames = r.body as Any[];
				expect(frames.map((f) => f.type)).toEqual(["attached", "error"]);
				expect(frames[1]).toMatchObject({
					code: "agent_unavailable",
					retryable: true,
					stdoutOffset: 2,
					stderrOffset: 0,
				});
				expect(opens).toBe(3);
			} finally {
				restore();
			}
			// The retry the frame invites works once the agent is back.
			const again = await fast.request(
				"GET",
				`${s.commands}/${id}/stream?stdoutOffset=2&stderrOffset=0&follow=false`,
			);
			expect(
				bytesOf(again.body as Frame[], "utf8", { stdout: 2 }).stdout.toString(),
			).toBe("c");
			await fast.request("POST", `${s.commands}/${id}/kill`, {
				json: { graceMs: 0 },
			});
		});

		it("a fatal agent error (command not found) is not retryable", async () => {
			const s = await readySandbox(w);
			const fast = w.harness({ deps: { commandTimings: timings } });
			const start = await fast.request("POST", s.commands, {
				json: { command: "sleep 2", mode: "detached" },
			});
			const id = (start.body as Any).id;
			let opens = 0;
			const restore = patchAttach(s.machineId, async function* () {
				opens++;
				yield* [];
				throw new AgentCallError("command_not_found", "gone");
			});
			try {
				const r = await fast.request("GET", `${s.commands}/${id}/stream`);
				const frames = r.body as Any[];
				expect(frames.at(-1)).toMatchObject({
					type: "error",
					code: "not_found",
					retryable: false,
					stdoutOffset: 0,
				});
				expect(opens).toBe(1);
			} finally {
				restore();
			}
			await fast.request("POST", `${s.commands}/${id}/kill`, {
				json: { graceMs: 0 },
			});
		});
	});

	it("heartbeat after silence", async () => {
		const fast = w.harness({
			deps: {
				commandTimings: {
					readyWaitMs: 1000,
					heartbeatMs: 100,
					maxDurationMs: 60_000,
				},
			},
		});
		// Silent until two heartbeats came, however long that takes here.
		const gate = shellGate();
		const s = await stream({ command: `${gate.shell}; echo x` }, fast);
		await s.until((f) => f.type === "heartbeat");
		await s.until((f) => f.type === "heartbeat");
		gate.open();
		await s.rest();
		const frames = s.frames;
		const beats = frames.filter((f) => f.type === "heartbeat").length;
		expect(beats).toBeGreaterThanOrEqual(2);
		expect(frames.map((f) => f.type).at(-1)).toBe("exit");
		expect(frames[0]?.type).toBe("started");
	});

	it("max duration: reconnect {max_duration} with offsets; /stream from them finishes", async () => {
		const short = w.harness({
			deps: {
				commandTimings: {
					readyWaitMs: 1000,
					heartbeatMs: 15_000,
					maxDurationMs: 300,
				},
			},
		});
		// "second" only after the reconnect. Whether "first" made it before
		// the 300 ms is timing: the offsets must match what was delivered.
		const gate = shellGate();
		const s = await stream(
			{ command: `echo first; ${gate.shell}; echo second` },
			short,
		);
		const frames = await s.rest();
		const last = frames.at(-1) as Any;
		const head = bytesOf(frames).stdout;
		expect(last).toMatchObject({
			type: "reconnect",
			reason: "max_duration",
			stdoutOffset: head.length,
			stderrOffset: 0,
		});
		gate.open();
		const again = await openStream(
			h,
			"GET",
			`${sb.commands}/${commandIdOf(frames)}/stream?stdoutOffset=${head.length}&stderrOffset=0`,
		);
		const rest = await again.rest();
		const tail = bytesOf(rest, "utf8", { stdout: head.length }).stdout;
		expect(Buffer.concat([head, tail]).toString()).toBe("first\nsecond\n");
		expect(rest.at(-1)).toMatchObject({ type: "exit", stdoutOffset: 13 });
	});

	it("offsets past the end of an exited command: 416 range_not_satisfiable, not a reopen loop", async () => {
		const r = await h.request("POST", sb.commands, {
			json: { command: "printf abc; printf de >&2" },
		});
		expect(r.status).toBe(200);
		const id = (r.body as Any).command.id as string;
		const path = `${sb.commands}/${id}/stream`;
		const past = await h.request("GET", `${path}?stdoutOffset=4`);
		expect(past.status).toBe(416);
		expect(past.body).toMatchObject({
			error: { code: "range_not_satisfiable", details: { size: 3 } },
		});
		const pastErr = await h.request("GET", `${path}?stderrOffset=9`);
		expect(pastErr.status).toBe(416);
		// At the end exactly: attached, then exit.
		const atEnd = await openStream(
			h,
			"GET",
			`${path}?stdoutOffset=3&stderrOffset=2`,
		);
		expect(atEnd.status).toBe(200);
		const frames = await atEnd.rest();
		expect(frames.map((f) => f.type)).toEqual(["attached", "exit"]);
		// A stream this command does not have.
		const pty = await h.request("GET", `${path}?ptyOffset=1`);
		expect(pty.status).toBe(400);
		expect(pty.body).toMatchObject({ error: { code: "validation" } });
		const ptyZero = await openStream(h, "GET", `${path}?ptyOffset=0`);
		expect(ptyZero.status).toBe(200);
		await ptyZero.rest();
	});

	it("stdout/stderr offsets on a PTY command are a validation error", async () => {
		const r = await h.request("POST", `/v1/sandboxes/${sb.ref}/ptys`, {
			json: { cols: 80, rows: 24, command: "true" },
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		const id = (r.body as Any).id as string;
		const bad = await h.request(
			"GET",
			`${sb.commands}/${id}/stream?stdoutOffset=1`,
		);
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: { code: "validation" } });
	});

	it("output dropped by the agent (output_truncated): exit frame, Command and sync answer carry outputTruncated", async () => {
		const gate = shellGate();
		const s = await stream({ command: `${gate.shell}; echo x` });
		const started = (await s.next()) as Any;
		expect(started.type).toBe("started");
		const pub = started.commandId as string;
		w.agent.truncateOutput(pub.slice(4).toUpperCase(), "disk_full");
		gate.open();
		const frames = await s.rest();
		expect(frames.at(-1)).toMatchObject({
			type: "exit",
			outputTruncated: "disk_full",
		});
		const got = await h.request("GET", `${sb.commands}/${pub}`);
		expect((got.body as Any).outputTruncated).toBe("disk_full");

		const plain = await h.request("POST", sb.commands, {
			json: { command: "echo y" },
		});
		expect((plain.body as Any).command.outputTruncated).toBeNull();
		const normal = await stream({ command: "true" });
		expect((await normal.rest()).at(-1)).toMatchObject({
			type: "exit",
			outputTruncated: null,
		});
	});

	it("the client going away ends the stream and frees its registry slot", async () => {
		const s = await stream({ command: "sleep 30" });
		await s.next();
		expect(h.deps.streams.size).toBe(1);
		await s.cancel();
		await until(() => h.deps.streams.size === 0, WAIT_MS, "slot freed");
	});

	it("HEAD of /stream answers no body and frees its registry slot", async () => {
		const r = await h.request("POST", sb.commands, {
			json: { mode: "detached", command: "sleep 5" },
		});
		const id = (r.body as Any).id as string;
		const head = await h.app.request(`${sb.commands}/${id}/stream`, {
			method: "HEAD",
			headers: { authorization: `Bearer ${h.bearer}` },
		});
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		await until(() => h.deps.streams.size === 0, WAIT_MS, "slot freed");
	});
});
