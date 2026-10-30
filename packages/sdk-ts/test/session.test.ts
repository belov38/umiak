// Browser session mode (S8 §9.1): the dashboard calls the proxied listener
// on its own origin; oauth2-proxy's cookie is the credential, so the SDK
// sends no Authorization (the proxied listener refuses one) and needs no
// credential chain.
import { describe, expect, it } from "vitest";
import {
	createClientCore,
	type WebSocketFactory,
	type WebSocketInit,
} from "../src/client.ts";
import { Command } from "../src/commands.ts";
import { resolveCredentials } from "../src/credentials.ts";
import { PTY_SUBPROTOCOL, Pty } from "../src/pty.ts";
import { Sbx } from "../src/sbx.ts";

const APP = "https://app.example.test/api";

describe("session mode", () => {
	it("needs only a baseUrl; never runs `sbx` or reads tokens from env", async () => {
		const c = await resolveCredentials({
			baseUrl: "/api",
			session: true,
			team: "team_1",
			env: { SBX_API_KEY: "sbx_env" },
			authCommand: ["/nonexistent"],
		});
		expect(c).toMatchObject({ baseUrl: "/api", team: "team_1", session: true });
		await expect(
			resolveCredentials({ session: true, env: {} }),
		).rejects.toMatchObject({ code: "no_api_url" });
	});

	it("requests carry Sbx-Team and no Authorization", async () => {
		const seen: Request[] = [];
		const sbx = new Sbx({
			baseUrl: APP,
			session: true,
			team: "team_1",
			env: {},
			fetch: (async (input: Request) => {
				seen.push(input);
				return new Response(JSON.stringify({ data: [], nextCursor: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});
		for await (const _ of sbx.sandboxes.list()) {
			// empty
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toMatch(
			/^https:\/\/app\.example\.test\/api\/v1\/sandboxes/,
		);
		expect(seen[0]?.headers.get("authorization")).toBe(null);
		expect(seen[0]?.headers.get("sbx-team")).toBe("team_1");
	});

	it("PTY: team in the query (browsers set no WebSocket headers), no Authorization", async () => {
		const calls: { url: string; init: WebSocketInit }[] = [];
		const factory: WebSocketFactory = (url, init) => {
			calls.push({ url, init });
			return { readyState: 0, close() {}, send() {} } as unknown as WebSocket;
		};
		const core = createClientCore({
			baseUrl: APP,
			session: true,
			team: "team_1",
			userAgent: "ua/1",
			env: {},
			webSocket: factory,
		});
		const pty = new Pty(core, new Command({ core, id: "sb_1" }, "cmd_1"), {
			tailBytes: 65_536,
		});
		for (let i = 0; i < 50 && calls.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		pty.close();
		expect(calls[0]?.url).toBe(
			"wss://app.example.test/api/v1/sandboxes/sb_1/ptys/cmd_1/connect?tailBytes=65536&team=team_1",
		);
		expect(calls[0]?.init).toEqual({
			protocols: [PTY_SUBPROTOCOL],
			headers: { "User-Agent": "ua/1" },
		});
	});
});
