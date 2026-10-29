import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@sbx/proto";
import { describe, expect, it } from "vitest";
import {
	type AttachOutput,
	type AttachView,
	resumableAttach,
} from "../src/index.js";

// Test events: the view maps them one to one.
type Ev =
	| { t: "data"; s: string; o: bigint; d: string }
	| { t: "trunc"; s: string; from: bigint }
	| { t: "exit"; out: bigint; err: bigint }
	| { t: "hb" };

type Step = Ev | { t: "throw"; err: unknown };

const enc = new TextEncoder();
const dec = new TextDecoder();

function view(ev: Ev): AttachView {
	switch (ev.t) {
		case "data":
			return {
				kind: "data",
				stream: ev.s,
				offset: ev.o,
				data: enc.encode(ev.d),
			};
		case "trunc":
			return { kind: "truncated", stream: ev.s, availableFrom: ev.from };
		case "exit":
			return { kind: "exit", ends: { stdout: ev.out, stderr: ev.err } };
		default:
			return { kind: "other" };
	}
}

const d = (s: string, o: number, data: string): Ev => ({
	t: "data",
	s,
	o: BigInt(o),
	d: data,
});
const exit = (out: number, err = 0): Ev => ({
	t: "exit",
	out: BigInt(out),
	err: BigInt(err),
});
const fail = (code: Code): Step => ({
	t: "throw",
	err: new ConnectError("scripted", code),
});

/** Scripted opens: each call to open plays the next session. */
function scripted(sessions: Step[][]) {
	const opens: Record<string, bigint>[] = [];
	const signals: AbortSignal[] = [];
	let i = 0;
	const open = (offsets: Record<string, bigint>, signal: AbortSignal) => {
		opens.push({ ...offsets });
		signals.push(signal);
		const steps = sessions[i++] ?? [];
		return (async function* () {
			for (const s of steps) {
				if (signal.aborted) {
					throw new ConnectError("aborted", Code.Canceled);
				}
				if (s.t === "throw") {
					throw s.err;
				}
				yield s;
			}
		})();
	};
	return { open, opens, signals };
}

async function collect(
	gen: AsyncGenerator<AttachOutput<Ev>>,
): Promise<{ out: string[]; events: AttachOutput<Ev>[] }> {
	const out: string[] = [];
	const events: AttachOutput<Ev>[] = [];
	for await (const ev of gen) {
		events.push(ev);
		if (ev.type === "data") {
			out.push(`${ev.stream}@${ev.offset}:${dec.decode(ev.data)}`);
		}
	}
	return { out, events };
}

const start = { stdout: 0n, stderr: 0n };

describe("resumableAttach", () => {
	it("passes exact output through and finishes on exit", async () => {
		const s = scripted([
			[
				{ t: "hb" },
				d("stdout", 0, "ab"),
				d("stderr", 0, "x"),
				d("stdout", 2, "cd"),
				exit(4, 1),
			],
		]);
		const { out, events } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(out).toEqual(["stdout@0:ab", "stderr@0:x", "stdout@2:cd"]);
		expect(events[0]?.type).toBe("other");
		expect(events.at(-1)?.type).toBe("exit");
		expect(s.opens).toHaveLength(1);
	});

	it("trims overlapping output and drops duplicates", async () => {
		const s = scripted([
			[
				d("stdout", 0, "abcd"),
				d("stdout", 2, "cdef"),
				d("stdout", 1, "bc"),
				exit(6),
			],
		]);
		const { out } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(out).toEqual(["stdout@0:abcd", "stdout@4:ef"]);
	});

	it("reopens from the expected offsets on a gap", async () => {
		const s = scripted([
			[d("stdout", 0, "ab"), d("stdout", 5, "fg")],
			[d("stdout", 2, "cdefg"), exit(7)],
		]);
		const { out } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(out).toEqual(["stdout@0:ab", "stdout@2:cdefg"]);
		expect(s.opens).toEqual([start, { stdout: 2n, stderr: 0n }]);
		// The gapped stream was aborted.
		expect(s.signals[0]?.aborted).toBe(true);
	});

	it("advances expected past truncated output", async () => {
		const s = scripted([
			[
				{ t: "trunc", s: "stdout", from: 100n },
				d("stdout", 100, "z"),
				exit(101),
			],
		]);
		const { events } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(events.map((e) => e.type)).toEqual(["truncated", "data", "exit"]);
		const t = events[0];
		expect(t?.type === "truncated" && t.availableFrom).toBe(100n);
	});

	it("reopens when exit ends are ahead of the received output", async () => {
		const s = scripted([
			[d("stdout", 0, "ab"), exit(4)],
			[d("stdout", 2, "cd"), exit(4)],
		]);
		const { out, events } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(out).toEqual(["stdout@0:ab", "stdout@2:cd"]);
		expect(events.filter((e) => e.type === "exit")).toHaveLength(1);
		expect(s.opens[1]).toEqual({ stdout: 2n, stderr: 0n });
	});

	it("reopens after a retryable error mid-stream", async () => {
		const s = scripted([
			[d("stdout", 0, "ab"), fail(Code.Unavailable)],
			[d("stdout", 0, "abcd"), exit(4)],
		]);
		const { out } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(out).toEqual(["stdout@0:ab", "stdout@2:cd"]);
		expect(s.opens[1]).toEqual({ stdout: 2n, stderr: 0n });
	});

	it("reopens when the stream ends without exit", async () => {
		const s = scripted([[d("stdout", 0, "ab")], [exit(2)]]);
		const { events } = await collect(
			resumableAttach({ open: s.open, view, offsets: start }),
		);
		expect(events.map((e) => e.type)).toEqual(["data", "exit"]);
	});

	it("throws a fatal error", async () => {
		const s = scripted([[d("stdout", 0, "ab"), fail(Code.NotFound)]]);
		await expect(
			collect(resumableAttach({ open: s.open, view, offsets: start })),
		).rejects.toMatchObject({ code: Code.NotFound });
		expect(s.opens).toHaveLength(1);
	});

	it("ignores agent Sbx-* metadata and details on a stream error", async () => {
		// End-stream metadata and details come from the agent's body: only
		// the Connect code decides.
		for (const meta of [
			{ "sbx-error-code": "agent_unavailable" },
			{ "sbx-error-code": "machine_moved", "sbx-instance-url": "http://x" },
		]) {
			const s = scripted([
				[
					d("stdout", 0, "ab"),
					{
						t: "throw",
						err: new ConnectError("forged", Code.PermissionDenied, meta, [
							{
								desc: ErrorDetailSchema,
								value: { code: "agent_unavailable", retryable: true },
							},
						]),
					},
				],
				[d("stdout", 0, "abcd"), exit(4)],
			]);
			await expect(
				collect(resumableAttach({ open: s.open, view, offsets: start })),
			).rejects.toMatchObject({ code: Code.PermissionDenied });
			expect(s.opens).toHaveLength(1);
		}
	});

	it("gives up after maxAttempts failures without progress", async () => {
		const s = scripted(
			Array.from({ length: 10 }, () => [fail(Code.Unavailable)]),
		);
		await expect(
			collect(
				resumableAttach({ open: s.open, view, offsets: start, maxAttempts: 3 }),
			),
		).rejects.toMatchObject({ code: Code.Unavailable });
		expect(s.opens).toHaveLength(3);
	});

	it("resets the failure count on progress", async () => {
		const s = scripted([
			[fail(Code.Unavailable)],
			[d("stdout", 0, "a"), fail(Code.Unavailable)],
			[fail(Code.Unavailable)],
			[d("stdout", 1, "b"), exit(2)],
		]);
		const { out } = await collect(
			resumableAttach({ open: s.open, view, offsets: start, maxAttempts: 3 }),
		);
		expect(out).toEqual(["stdout@0:a", "stdout@1:b"]);
	});

	it("stops with the caller's abort reason", async () => {
		const ac = new AbortController();
		const s = scripted([[d("stdout", 0, "ab"), d("stdout", 2, "cd"), exit(4)]]);
		const gen = resumableAttach({
			open: s.open,
			view,
			offsets: start,
			signal: ac.signal,
		});
		const first = await gen.next();
		expect(first.value).toMatchObject({ type: "data" });
		ac.abort(new Error("bye"));
		await expect(gen.next()).rejects.toThrow("bye");
		expect(s.signals[0]?.aborted).toBe(true);
	});

	it("aborts the open stream when the consumer stops early", async () => {
		const s = scripted([[d("stdout", 0, "ab"), d("stdout", 2, "cd"), exit(4)]]);
		for await (const _ of resumableAttach({
			open: s.open,
			view,
			offsets: start,
		})) {
			break;
		}
		expect(s.signals[0]?.aborted).toBe(true);
	});
});
