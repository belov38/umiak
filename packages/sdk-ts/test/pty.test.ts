// PTY client parts that need no api: input queued while not connected.
import { describe, expect, it } from "vitest";
import {
	type ClientCore,
	createClientCore,
	type WebSocketFactory,
	type WebSocketInit,
} from "../src/client.ts";
import { Command } from "../src/commands.ts";
import { SbxError } from "../src/errors.ts";
import { PTY_SUBPROTOCOL, Pty } from "../src/pty.ts";

describe("Pty input while not connected", () => {
	it("queues up to 1 MiB, then throws pty_input_overflow", () => {
		// Credentials never resolve: the PTY never connects.
		const core = {
			credentials: () => new Promise(() => {}),
			userAgent: "test",
		} as unknown as ClientCore;
		const pty = new Pty(core, new Command({ core, id: "sb_1" }, "cmd_1"), {});
		pty.write(new Uint8Array(1024 * 1024));
		let err: unknown;
		try {
			pty.write("x");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SbxError);
		expect(err).toMatchObject({ code: "pty_input_overflow", retryable: true });
		pty.close();
	});
});

describe("Pty WebSocket factory (SbxOptions.webSocket)", () => {
	it("opens the connection through the factory with the URL, subprotocol and headers", async () => {
		const calls: { url: string; init: WebSocketInit }[] = [];
		const factory: WebSocketFactory = (url, init) => {
			calls.push({ url, init });
			// A socket that never opens; the test only looks at the call.
			return {
				readyState: 0,
				close() {},
				send() {},
			} as unknown as WebSocket;
		};
		const core = createClientCore({
			baseUrl: "https://api.example.com",
			apiKey: "sbx_test",
			team: "team_1",
			userAgent: "ua/1",
			webSocket: factory,
		});
		expect(core.webSocket).toBe(factory);
		const pty = new Pty(core, new Command({ core, id: "sb_1" }, "cmd_1"), {
			tailBytes: 65_536,
		});
		for (let i = 0; i < 50 && calls.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		pty.close();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"wss://api.example.com/v1/sandboxes/sb_1/ptys/cmd_1/connect?tailBytes=65536",
		);
		expect(calls[0]?.init).toEqual({
			protocols: [PTY_SUBPROTOCOL],
			headers: {
				Authorization: "Bearer sbx_test",
				"User-Agent": "ua/1",
				"Sbx-Team": "team_1",
			},
		});
	});
});

describe("Pty truncated", () => {
	it("onTruncated reports where the output goes on after a gap; offset follows", async () => {
		let socket: Record<string, unknown> | undefined;
		const factory: WebSocketFactory = () => {
			socket = { readyState: 1, close() {}, send() {} };
			return socket as unknown as WebSocket;
		};
		const core = createClientCore({
			baseUrl: "https://api.example.com",
			apiKey: "sbx_test",
			webSocket: factory,
		});
		const pty = new Pty(core, new Command({ core, id: "sb_1" }, "cmd_1"), {});
		for (let i = 0; i < 50 && socket === undefined; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		const gaps: number[] = [];
		const off = pty.onTruncated((from) => gaps.push(from));
		const message = (data: unknown) =>
			(socket as { onmessage: (ev: { data: unknown }) => void }).onmessage({
				data,
			});
		message(JSON.stringify({ type: "attached", offset: 0 }));
		message(JSON.stringify({ type: "truncated", availableFrom: 4096 }));
		expect(gaps).toEqual([4096]);
		expect(pty.offset).toBe(4096);
		off();
		message(JSON.stringify({ type: "truncated", availableFrom: 8192 }));
		expect(gaps).toEqual([4096]);
		pty.close();
	});
});
