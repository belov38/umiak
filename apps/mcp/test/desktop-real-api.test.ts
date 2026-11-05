import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { Umiak } from "@umiak/sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type ApiWorld, apiWorld } from "../../api/test/helpers/world.ts";
import { createLogger } from "../src/log.ts";
import { createServer } from "../src/server.ts";
import { DESKTOP_TOOLS } from "../src/tools/desktop.ts";
import { connectInMemory, type InMemoryConnection } from "./helpers/connect.ts";

let db: TestDatabase;
let w: ApiWorld;
let connection: InMemoryConnection;
afterAll(async () => {
	await connection?.close();
	await w?.close();
	await db?.drop();
});
beforeAll(async () => {
	db = await createTestDatabase();
	w = await apiWorld(db.pool);
});
it("SDK facade and computer tools use the real public desktop API with a fake guest", async () => {
	const config = new Proxy(w.env.config, {
		get(t, k) {
			if (k === "template")
				return async (slug: string) => {
					const template = await t.template(slug);
					return template
						? {
								...template,
								capabilities: [...template.capabilities, "desktop"],
							}
						: null;
				};
			const value = Reflect.get(t, k);
			return typeof value === "function" ? value.bind(t) : value;
		},
	});
	const h = w.harness({ deps: { config } });
	const app = h.app;
	const umiak = new Umiak({
		baseUrl: "https://api.umiak.test",
		apiKey: w.secret,
		env: {},
		fetch: async (request) => app.request(request as Request),
	});
	const seeded = await w.seed({ state: "ready" });
	const sb = await umiak.sandboxes.get(seeded.slug);
	await sb.desktop.clipboardSet("SDK текст");
	expect((await sb.desktop.clipboardGet()).text).toBe("SDK текст");
	expect((await sb.desktop.screenshot({ format: "png" })).screen).toEqual({
		width: 1920,
		height: 1080,
	});
	connection = await connectInMemory(
		createServer({
			tools: DESKTOP_TOOLS,
			umiak: () => umiak,
			transport: "stdio",
			log: createLogger({ level: "silent" }),
		}),
	);
	for (const [name, args] of [
		["computer_clipboard_write", { text: "MCP текст" }],
		["computer_clipboard_read", {}],
		["computer_move", { x: 10, y: 20, screenshot_after: false }],
		["computer_screenshot", {}],
		["desktop_url", {}],
	] as const) {
		const response = await connection.client.callTool({
			name,
			arguments: { sandbox: seeded.slug, ...args },
		});
		expect(response.isError, name).not.toBe(true);
	}
	expect((await sb.desktop.clipboardGet()).text).toBe("MCP текст");
});
it("computer tools surface an operator block as a non-retryable error", async () => {
	const config = new Proxy(w.env.config, {
		get(t, k) {
			if (k === "template")
				return async (slug: string) => {
					const template = await t.template(slug);
					return template
						? {
								...template,
								capabilities: [...template.capabilities, "desktop"],
							}
						: null;
				};
			const value = Reflect.get(t, k);
			return typeof value === "function" ? value.bind(t) : value;
		},
	});
	const app = w.harness({ deps: { config } }).app;
	const umiak = new Umiak({
		baseUrl: "https://api.umiak.test",
		apiKey: w.secret,
		env: {},
		fetch: async (request) => app.request(request as Request),
	});
	const seeded = await w.seed({ state: "ready" });
	await db.pool.query("UPDATE runtime.sandboxes SET blocked=true WHERE id=$1", [
		seeded.sandboxId,
	]);
	const blocked = await connectInMemory(
		createServer({
			tools: DESKTOP_TOOLS,
			umiak: () => umiak,
			transport: "stdio",
			log: createLogger({ level: "silent" }),
		}),
	);
	try {
		for (const [name, args] of [
			["computer_type", { text: "id", screenshot_after: false }],
			["computer_clipboard_write", { text: "x" }],
			["desktop_url", {}],
		] as const) {
			const response = await blocked.client.callTool({
				name,
				arguments: { sandbox: seeded.slug, ...args },
			});
			expect(response.isError, name).toBe(true);
			const text = JSON.stringify(response.content);
			expect(text, name).toContain("forbidden");
			expect(text, name).toContain("blocked this sandbox");
		}
	} finally {
		await blocked.close();
	}
});
