// Browser session mode (S8 §9.1): the dashboard calls the proxied listener
// on its own origin; owner ingress's cookie is the credential, so the SDK
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
import { Umiak } from "../src/umiak.ts";

const APP = "https://app.example.test/api";

describe("session mode", () => {
	it("needs only a baseUrl; never runs `umiak` or reads tokens from env", async () => {
		const c = await resolveCredentials({
			baseUrl: "/api",
			session: true,
			team: "team_1",
			env: { UMIAK_API_KEY: "umiak_env" },
			authCommand: ["/nonexistent"],
		});
		expect(c).toMatchObject({ baseUrl: "/api", team: "team_1", session: true });
		await expect(
			resolveCredentials({ session: true, env: {} }),
		).rejects.toMatchObject({ code: "no_api_url" });
	});

	it("requests carry Umiak-Team and no Authorization", async () => {
		const seen: Request[] = [];
		const umiak = new Umiak({
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
		for await (const _ of umiak.sandboxes.list()) {
			// empty
		}
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toMatch(
			/^https:\/\/app\.example\.test\/api\/v1\/sandboxes/,
		);
		expect(seen[0]?.headers.get("authorization")).toBe(null);
		expect(seen[0]?.headers.get("umiak-team")).toBe("team_1");
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

	it("sandboxes.handle builds a handle from data without a request", async () => {
		const seen: Request[] = [];
		const umiak = new Umiak({
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
		const sb = umiak.sandboxes.handle({
			id: "sb_1",
			slug: "quiet-otter-lamp",
			state: "stopped",
		} as never);
		expect(sb.id).toBe("sb_1");
		expect(seen).toHaveLength(0);
		for await (const _ of sb.files.list("/")) {
			// empty
		}
		expect(seen[0]?.url).toMatch(/\/api\/v1\/sandboxes\/sb_1\/files\/list/);
		expect(seen[0]?.headers.get("umiak-team")).toBe("team_1");
	});
});
