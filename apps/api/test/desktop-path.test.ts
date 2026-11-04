import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testSettings } from "../src/testing/index.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

let db: TestDatabase;
let w: ApiWorld;
beforeAll(async () => {
	db = await createTestDatabase();
	w = await apiWorld(db.pool);
});
afterAll(async () => {
	await w?.close();
	await db?.drop();
});

async function link(
	env: Record<string, string>,
	json: Record<string, unknown> = {},
) {
	const config = new Proxy(w.env.config, {
		get(target, key) {
			if (key === "template")
				return async (slug: string) => {
					const t = await target.template(slug);
					return t
						? { ...t, capabilities: [...t.capabilities, "desktop"] }
						: null;
				};
			const v = Reflect.get(target, key);
			return typeof v === "function" ? v.bind(target) : v;
		},
	});
	const h = w.harness({ deps: { config, settings: testSettings(env) } });
	const s = await w.seed({ state: "ready" });
	const r = await h.request("POST", `/v1/sandboxes/${s.slug}/desktop/links`, {
		json,
	});
	expect(r.status).toBe(201);
	const body = r.body as { url: string; expiresAt: string };
	const tickets = await db.pool.query(
		"SELECT count(*)::int AS n FROM runtime.desktop_tickets WHERE sandbox_id=$1",
		[s.sandboxId],
	);
	return { s, body, url: new URL(body.url), tickets: tickets.rows[0].n };
}

describe("path-form desktop links", () => {
	const env = { UMIAK_DESKTOP_PATH_PREFIX: "/desktop" };
	it("defaults to websocket on the owner origin without a ticket", async () => {
		const { s, body, url, tickets } = await link(env);
		expect(url.origin).toBe(new URL(testSettings(env).appOrigin).origin);
		expect(url.pathname).toBe(`/desktop/${s.slug}/`);
		expect(url.searchParams.get("dataTransport")).toBe("websocket");
		expect(url.searchParams.has("_ticket")).toBe(false);
		expect(tickets).toBe(0);
		expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
	});
	it("honours explicit webrtc", async () => {
		const { url } = await link(env, { transport: "webrtc" });
		expect(url.searchParams.get("dataTransport")).toBe("webrtc");
	});
	it("passes fps and bitrate through", async () => {
		const { url } = await link(env, { fps: 60, bitrateKbps: 8000 });
		expect(url.searchParams.get("fps")).toBe("60");
		expect(url.searchParams.get("bitrate")).toBe("8000");
		expect(url.searchParams.get("dataTransport")).toBe("websocket");
	});
	it("keeps hostname links with a ticket when the prefix is unset", async () => {
		const { s, url, tickets } = await link({});
		expect(url.hostname).toBe(`${s.slug}-desktop.umiak.test`);
		expect(url.searchParams.get("_ticket")).toMatch(/^umiakd_/);
		expect(tickets).toBe(1);
	});
});
