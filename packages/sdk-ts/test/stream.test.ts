// The reconnect policy of command streams (S7 §15.4) with a scripted fetch
// and fake timers: no overall time limit while output arrives, 20 attempts
// in a row without new bytes end with the last error, a `reconnect` frame
// is followed at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientCore } from "../src/client.ts";
import { Command, runCommand } from "../src/commands.ts";
import { UmiakError } from "../src/errors.ts";

const API = "https://api.example.test";

function ndjson(...frames: unknown[]) {
	return new Response(frames.map((f) => `${JSON.stringify(f)}\n`).join(""), {
		status: 200,
		headers: {
			"Content-Type": "application/x-ndjson",
			"Umiak-Command-Id": "cmd_1",
		},
	});
}

function unavailable() {
	return new Response(
		JSON.stringify({
			error: {
				code: "agent_unavailable",
				message: "agent unavailable",
				retryable: true,
				details: {},
				requestId: "req_1",
			},
		}),
		{ status: 503, headers: { "Content-Type": "application/json" } },
	);
}

const out = (offset: number, data: string) => ({
	type: "stdout",
	offset,
	nextOffset: offset + data.length,
	data,
});

/** A sandbox ref over a fetch that answers per request with `reply`. */
function sandbox(reply: (req: Request, n: number) => Response) {
	const urls: string[] = [];
	const core = createClientCore({
		baseUrl: API,
		apiKey: "umiak_test",
		env: {},
		fetch: (async (req: Request) => {
			urls.push(
				`${req.method} ${new URL(req.url).pathname}${new URL(req.url).search}`,
			);
			return reply(req, urls.length);
		}) as typeof fetch,
	});
	return { sb: { core, id: "sb_1" }, urls };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("command stream reconnects", () => {
	it("20 attempts in a row without new bytes end with the last error", async () => {
		const { sb, urls } = sandbox((req) =>
			req.method === "POST"
				? ndjson({ type: "started", commandId: "cmd_1" }, out(0, "ab"))
				: unavailable(),
		);
		const events: unknown[] = [];
		const p = (async () => {
			for await (const ev of runCommand(sb, "x")) events.push(ev);
		})().catch((e: unknown) => e);
		await vi.runAllTimersAsync();
		const err = await p;
		expect(err).toBeInstanceOf(UmiakError);
		expect(err).toMatchObject({ code: "agent_unavailable" });
		expect(events).toEqual([expect.objectContaining({ data: "ab" })]);
		const gets = urls.filter((u) => u.startsWith("GET"));
		expect(gets).toHaveLength(20);
		expect(gets[0]).toContain("stdoutOffset=2");
	});

	it("progress resets the count: no overall limit while bytes arrive", async () => {
		// Every reattach brings one byte, then the stream breaks again.
		let at = 0;
		const { sb, urls } = sandbox((req) => {
			if (req.method === "POST")
				return ndjson({ type: "started", commandId: "cmd_1" });
			if (at >= 40) {
				return ndjson(
					{
						type: "attached",
						commandId: "cmd_1",
						stdoutOffset: at,
						stderrOffset: 0,
						encoding: "utf8",
					},
					{
						type: "exit",
						status: "exited",
						exitCode: 0,
						signal: null,
						reason: "none",
						stdoutOffset: at,
						stderrOffset: 0,
					},
				);
			}
			const frame = out(at, "z");
			at += 1;
			return ndjson(
				{
					type: "attached",
					commandId: "cmd_1",
					stdoutOffset: frame.offset,
					stderrOffset: 0,
					encoding: "utf8",
				},
				frame,
			);
		});
		let text = "";
		const p = (async () => {
			for await (const ev of runCommand(sb, "x")) {
				if (ev.type === "stdout") text += ev.data;
			}
		})();
		await vi.runAllTimersAsync();
		await p;
		expect(text).toBe("z".repeat(40));
		expect(urls.filter((u) => u.startsWith("GET")).length).toBe(41);
	});

	it("a reconnect frame is followed at once from its offsets", async () => {
		const { sb, urls } = sandbox((req) =>
			req.method === "POST"
				? ndjson({ type: "started", commandId: "cmd_1" }, out(0, "abc"), {
						type: "reconnect",
						reason: "server_shutdown",
						stdoutOffset: 3,
						stderrOffset: 0,
					})
				: ndjson(
						{
							type: "attached",
							commandId: "cmd_1",
							stdoutOffset: 3,
							stderrOffset: 0,
							encoding: "utf8",
						},
						out(3, "d"),
						{
							type: "exit",
							status: "exited",
							exitCode: 0,
							signal: null,
							reason: "none",
							stdoutOffset: 4,
							stderrOffset: 0,
						},
					),
		);
		let text = "";
		for await (const ev of runCommand(sb, "x")) {
			if (ev.type === "stdout") text += ev.data;
		}
		expect(text).toBe("abcd");
		expect(urls[1]).toContain("stdoutOffset=3");
	});

	it("a non-retryable error frame ends the stream with that error", async () => {
		const { sb } = sandbox(() =>
			ndjson(
				{ type: "started", commandId: "cmd_1" },
				{
					type: "error",
					code: "unauthorized",
					message: "revoked",
					retryable: false,
					requestId: "req_9",
					stdoutOffset: 0,
					stderrOffset: 0,
				},
			),
		);
		const err = await (async () => {
			for await (const _ of runCommand(sb, "x")) {
				// no output
			}
		})().catch((e: unknown) => e);
		expect(err).toMatchObject({
			name: "UmiakError",
			code: "unauthorized",
			retryable: false,
			requestId: "req_9",
		});
	});

	it("before the command id is known, the call's retry budget bounds the start", async () => {
		const { sb, urls } = sandbox(() => unavailable());
		const started = Date.now();
		const p = (async () => {
			for await (const _ of runCommand(sb, "ls", { retryBudgetMs: 1000 })) {
				// no output
			}
		})().catch((e: unknown) => e);
		await vi.runAllTimersAsync();
		const err = await p;
		expect(err).toMatchObject({ code: "agent_unavailable" });
		expect(Date.now() - started).toBeLessThanOrEqual(1000);
		expect(urls.every((u) => u.startsWith("POST"))).toBe(true);
		expect(urls.length).toBeGreaterThanOrEqual(2);
	});

	it("a utf8 frame that overlaps the tracked offset is a protocol error: reattach", async () => {
		let gets = 0;
		const { sb, urls } = sandbox((req) => {
			if (req.method === "POST") {
				return ndjson({ type: "started", commandId: "cmd_1" }, out(0, "abc"));
			}
			gets += 1;
			return gets === 1
				? ndjson(
						{
							type: "attached",
							commandId: "cmd_1",
							stdoutOffset: 3,
							stderrOffset: 0,
							encoding: "utf8",
						},
						out(1, "bcd"),
					)
				: ndjson(
						{
							type: "attached",
							commandId: "cmd_1",
							stdoutOffset: 3,
							stderrOffset: 0,
							encoding: "utf8",
						},
						out(3, "d"),
						{
							type: "exit",
							status: "exited",
							exitCode: 0,
							signal: null,
							reason: "none",
							stdoutOffset: 4,
							stderrOffset: 0,
						},
					);
		});
		let text = "";
		const p = (async () => {
			for await (const ev of runCommand(sb, "x")) {
				if (ev.type === "stdout") text += ev.data;
			}
		})();
		await vi.runAllTimersAsync();
		await p;
		expect(text).toBe("abcd");
		expect(urls.filter((u) => u.startsWith("GET"))).toHaveLength(2);
	});

	it("a base64 frame that overlaps the tracked offset is cut to its new bytes", async () => {
		const b64 = (t: string) => Buffer.from(t).toString("base64");
		const { sb } = sandbox((req) =>
			req.method === "POST"
				? ndjson(
						{ type: "started", commandId: "cmd_1" },
						{ type: "stdout", offset: 0, nextOffset: 3, data: b64("abc") },
					)
				: ndjson(
						{
							type: "attached",
							commandId: "cmd_1",
							stdoutOffset: 3,
							stderrOffset: 0,
							encoding: "base64",
						},
						{ type: "stdout", offset: 1, nextOffset: 5, data: b64("bcde") },
						{
							type: "exit",
							status: "exited",
							exitCode: 0,
							signal: null,
							reason: "none",
							stdoutOffset: 5,
							stderrOffset: 0,
						},
					),
		);
		const parts: { offset: number; text: string }[] = [];
		const p = (async () => {
			for await (const ev of runCommand(sb, "x", { encoding: "base64" })) {
				if (ev.type === "stdout") {
					parts.push({
						offset: ev.offset,
						text: Buffer.from(ev.data).toString(),
					});
				}
			}
		})();
		await vi.runAllTimersAsync();
		await p;
		expect(parts).toEqual([
			{ offset: 0, text: "abc" },
			{ offset: 3, text: "de" },
		]);
	});

	it("follow from the end keeps tailBytes until a stream is attached", async () => {
		let gets = 0;
		const { sb, urls } = sandbox(() => {
			gets += 1;
			// The first stream is answered but ends before its `attached` frame.
			return gets === 1
				? ndjson()
				: ndjson(
						{
							type: "attached",
							commandId: "cmd_1",
							stdoutOffset: 9,
							stderrOffset: 2,
							encoding: "utf8",
						},
						{
							type: "exit",
							status: "exited",
							exitCode: 0,
							signal: null,
							reason: "none",
							stdoutOffset: 9,
							stderrOffset: 2,
						},
					);
		});
		const events: unknown[] = [];
		const p = (async () => {
			for await (const ev of new Command(sb, "cmd_1").follow({ from: "end" })) {
				events.push(ev);
			}
		})();
		await vi.runAllTimersAsync();
		await p;
		expect(urls).toHaveLength(2);
		for (const u of urls) {
			expect(u).toContain("tailBytes=0");
			expect(u).not.toContain("stdoutOffset");
		}
		expect(events).toEqual([expect.objectContaining({ type: "exit" })]);
	});
});
