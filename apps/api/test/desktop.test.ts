import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recheckDesktopAccess } from "../src/desktop/revocation.ts";
import { ServiceTokens } from "../src/index.ts";
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
it("desktop contract: status, image metadata, actions and clipboard through real routes", async () => {
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
	const h = w.harness({ deps: { config } });
	const s = await w.seed({ state: "ready" });
	const root = `/v1/sandboxes/${s.slug}/desktop`;
	expect((await h.request("GET", root)).status).toBe(200);
	const clip = await h.request("PUT", `${root}/clipboard`, {
		json: { text: "Привет 🌍" },
	});
	expect(clip.status).toBe(204);
	expect((await h.request("GET", `${root}/clipboard`)).body).toEqual({
		text: "Привет 🌍",
		hasText: true,
	});
	const image = await h.request(
		"GET",
		`${root}/screenshot?format=png&maxWidth=1280&maxHeight=720`,
	);
	expect(image.status).toBe(200);
	expect(image.headers.get("content-type")).toBe("image/png");
	expect(image.headers.get("sbx-screen-width")).toBe("1920");
	expect(image.bytes.length).toBeGreaterThan(0);
	const actions = await h.request("POST", `${root}/actions`, {
		json: {
			actions: [{ type: "move", x: 10, y: 20 }],
			screenshot: { format: "png", maxWidth: 1280, maxHeight: 720 },
		},
	});
	expect(actions.status).toBe(200);
	expect(actions.body).toMatchObject({
		completed: 1,
		screen: { width: 1920, height: 1080 },
		screenshot: { contentType: "image/png" },
	});
	const link = await h.request("POST", `${root}/links`, {
		json: { fps: 30, transport: "websocket" },
	});
	expect(link.status).toBe(201);
	const url = new URL((link.body as { url: string }).url);
	expect(url.searchParams.get("fps")).toBe("30");
	const ticket = url.searchParams.get("_ticket");
	const gateway = w.harness({
		listener: "internal",
		bearer: "gateway-desktop-token",
		deps: {
			config,
			serviceTokens: new ServiceTokens({ gateway: ["gateway-desktop-token"] }),
		},
	});
	const exchange = () =>
		gateway.request("POST", "/internal/v1/gateway/desktop/tickets/exchange", {
			json: { ticket, label: `${s.slug}-desktop` },
		});
	expect((await exchange()).status).toBe(200);
	expect((await exchange()).status).toBe(401);
	expect(
		(await h.request("PUT", `${root}/access`, { json: { access: "sso" } }))
			.status,
	).toBe(200);
	expect((await h.request("DELETE", `${root}/streams`)).status).toBe(204);
	const route = await gateway.request(
		"GET",
		`/internal/v1/gateway/routes/${s.slug}-desktop`,
	);
	expect(route.body).toMatchObject({
		kind: "desktop",
		port: 47800,
		authEpoch: 3,
	});
	const resource = await h.request("GET", `/v1/sandboxes/${s.slug}`);
	expect(resource.body).toMatchObject({
		endpoints: {
			desktop: `https://${s.slug}-desktop.${h.deps.settings.sbxDomain}/`,
		},
	});
});
it("desktop unsupported is 422, unknown sandbox remains 404", async () => {
	const h = w.harness();
	const s = await w.seed({ state: "ready" });
	expect(
		(await h.request("GET", `/v1/sandboxes/${s.slug}/desktop`)).status,
	).toBe(422);
	expect(
		(await h.request("GET", "/v1/sandboxes/unknown-slug/desktop")).status,
	).toBe(404);
});

it("revoked and expired ticket principals advance the epoch and disconnect viewers", async () => {
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
	const key = await w.key(["desktop"]);
	const h = w.harness({ bearer: key.secret, deps: { config } });
	const seeded = await w.seed({ state: "ready" });
	const link = await h.request(
		"POST",
		`/v1/sandboxes/${seeded.slug}/desktop/links`,
	);
	expect(link.status).toBe(201);
	await w.identity.revokeApiKey(key.id, {});
	await recheckDesktopAccess(h.deps);
	const policy = await db.pool.query(
		"SELECT auth_epoch,pending_disconnect FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[seeded.sandboxId],
	);
	expect(policy.rows[0]).toEqual({ auth_epoch: 2, pending_disconnect: false });
});
