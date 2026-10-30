// The reconnect policy of command streams (S7 §15.4) with a scripted fetch
// and fake timers: no overall time limit while output arrives, 20 attempts
// in a row without new bytes end with the last error, a `reconnect` frame
// is followed at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientCore } from "../src/client.ts";
import { runCommand } from "../src/commands.ts";
import { SbxError } from "../src/errors.ts";

const API = "https://api.example.test";

function ndjson(...frames: unknown[]) {
	return new Response(frames.map((f) => `${JSON.stringify(f)}\n`).join(""), {
		status: 200,
		headers: {
			"Content-Type": "application/x-ndjson",
			"Sbx-Command-Id": "cmd_1",
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
		apiKey: "sbx_test",
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
		expect(err).toBeInstanceOf(SbxError);
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
			name: "SbxError",
			code: "unauthorized",
			retryable: false,
			requestId: "req_9",
		});
	});
});
