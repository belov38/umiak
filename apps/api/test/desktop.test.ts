import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { recheckDesktopAccess } from "../src/desktop/revocation.ts";
import { ticketHash } from "../src/desktop/service.ts";
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
	expect(image.headers.get("umiak-screen-width")).toBe("1920");
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
			desktop: `https://${s.slug}-desktop.${h.deps.settings.umiakDomain}/`,
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
	await db.pool.query(
		"UPDATE runtime.desktop_tickets SET created_at=now()-interval '13 hours',used_at=now()-interval '13 hours' WHERE sandbox_id=$1",
		[seeded.sandboxId],
	);
	await w.identity.revokeApiKey(key.id, {});
	await recheckDesktopAccess(h.deps);
	const policy = await db.pool.query(
		"SELECT auth_epoch,pending_disconnect FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[seeded.sandboxId],
	);
	expect(policy.rows[0]).toEqual({ auth_epoch: 2, pending_disconnect: false });
});

it.each(["public", "blocked"])(
	"revokes direct media when route policy becomes %s, only once per transition",
	async (kind) => {
		let publicEnabled = false;
		const config = new Proxy(w.env.config, {
			get(target, key) {
				if (key === "defaults")
					return async () => ({
						...(await target.defaults()),
						publicDesktopEnabled: publicEnabled,
					});
				if (key === "template")
					return async (slug: string) => {
						const t = await target.template(slug);
						return t
							? { ...t, capabilities: [...t.capabilities, "desktop"] }
							: null;
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const h = w.harness({ deps: { config } });
		const seeded = await w.seed({ state: "ready" });
		await db.pool.query(
			"INSERT INTO runtime.sandbox_desktops(sandbox_id,access) VALUES($1,$2)",
			[seeded.sandboxId, kind === "public" ? "public" : "token"],
		);
		if (kind === "blocked")
			await db.pool.query(
				"UPDATE runtime.sandboxes SET blocked=true WHERE id=$1",
				[seeded.sandboxId],
			);
		await recheckDesktopAccess(h.deps);
		const epoch = async () =>
			(
				await db.pool.query(
					"SELECT auth_epoch,pending_disconnect FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
					[seeded.sandboxId],
				)
			).rows[0];
		expect(await epoch()).toEqual({ auth_epoch: 2, pending_disconnect: false });
		await recheckDesktopAccess(h.deps);
		expect((await epoch()).auth_epoch).toBe(2);
		publicEnabled = true;
		await db.pool.query(
			"UPDATE runtime.sandboxes SET blocked=false WHERE id=$1",
			[seeded.sandboxId],
		);
		await recheckDesktopAccess(h.deps);
		publicEnabled = false;
		if (kind === "blocked")
			await db.pool.query(
				"UPDATE runtime.sandboxes SET blocked=true WHERE id=$1",
				[seeded.sandboxId],
			);
		await recheckDesktopAccess(h.deps);
		// Lifting the denial and denying again each advance the epoch.
		expect((await epoch()).auth_epoch).toBe(4);
	},
);

it("a ticket written while a block is applied stays invalid after unblock", async () => {
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
	const key = await w.key(["desktop"]);
	const h = w.harness({ bearer: key.secret, deps: { config } });
	const s = await w.seed({ state: "ready" });
	await db.pool.query(
		"INSERT INTO runtime.sandbox_desktops(sandbox_id,access) VALUES($1,'token')",
		[s.sandboxId],
	);
	await db.pool.query("UPDATE runtime.sandboxes SET blocked=true WHERE id=$1", [
		s.sandboxId,
	]);
	await recheckDesktopAccess(h.deps);
	// A link request that passed the block check before the block reads the new epoch.
	const ticket = `umiakd_${"r".repeat(43)}`;
	await db.pool.query(
		`INSERT INTO runtime.desktop_tickets(ticket_hash,sandbox_id,label,api_key_id,auth_epoch,expires_at)
		 SELECT $1,$2,$3,$4,auth_epoch,now()+interval '10 minutes' FROM runtime.sandbox_desktops WHERE sandbox_id=$2`,
		[ticketHash(ticket), s.sandboxId, `${s.slug}-desktop`, key.id],
	);
	await db.pool.query(
		"UPDATE runtime.sandboxes SET blocked=false WHERE id=$1",
		[s.sandboxId],
	);
	await recheckDesktopAccess(h.deps);
	const gateway = w.harness({
		listener: "internal",
		bearer: "gateway-desktop-token",
		deps: {
			config,
			serviceTokens: new ServiceTokens({ gateway: ["gateway-desktop-token"] }),
		},
	});
	const exchange = await gateway.request(
		"POST",
		"/internal/v1/gateway/desktop/tickets/exchange",
		{ json: { ticket, label: `${s.slug}-desktop` } },
	);
	expect(exchange.status).toBe(401);
});

it("between unblock and the access monitor a block-epoch ticket is refused and the desktop stays closed", async () => {
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
	const key = await w.key(["desktop"]);
	const h = w.harness({ bearer: key.secret, deps: { config } });
	const s = await w.seed({ state: "ready" });
	await db.pool.query(
		"INSERT INTO runtime.sandbox_desktops(sandbox_id,access) VALUES($1,'token')",
		[s.sandboxId],
	);
	await db.pool.query("UPDATE runtime.sandboxes SET blocked=true WHERE id=$1", [
		s.sandboxId,
	]);
	await recheckDesktopAccess(h.deps);
	const ticket = `umiakd_${"w".repeat(43)}`;
	await db.pool.query(
		`INSERT INTO runtime.desktop_tickets(ticket_hash,sandbox_id,label,api_key_id,auth_epoch,expires_at)
		 SELECT $1,$2,$3,$4,auth_epoch,now()+interval '10 minutes' FROM runtime.sandbox_desktops WHERE sandbox_id=$2`,
		[ticketHash(ticket), s.sandboxId, `${s.slug}-desktop`, key.id],
	);
	// Unblocked, but the monitor has not run yet: policy_revoked is still set.
	await db.pool.query(
		"UPDATE runtime.sandboxes SET blocked=false WHERE id=$1",
		[s.sandboxId],
	);
	const gateway = w.harness({
		listener: "internal",
		bearer: "gateway-desktop-token",
		deps: {
			config,
			serviceTokens: new ServiceTokens({ gateway: ["gateway-desktop-token"] }),
		},
	});
	const label = `${s.slug}-desktop`;
	const exchange = await gateway.request(
		"POST",
		"/internal/v1/gateway/desktop/tickets/exchange",
		{ json: { ticket, label } },
	);
	expect(exchange.status).toBe(401);
	const route = await gateway.request(
		"GET",
		`/internal/v1/gateway/routes/${label}`,
	);
	expect(route.body).toMatchObject({ blocked: true });
	// The monitor lifts the denial with a new epoch and ends any stream of the window.
	await db.pool.query(
		"UPDATE runtime.sandboxes SET machine_id=NULL WHERE id=$1",
		[s.sandboxId],
	);
	const before = await db.pool.query(
		"SELECT auth_epoch FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[s.sandboxId],
	);
	await recheckDesktopAccess(h.deps);
	const after = await db.pool.query(
		"SELECT auth_epoch,policy_revoked FROM runtime.sandbox_desktops WHERE sandbox_id=$1",
		[s.sandboxId],
	);
	expect(after.rows[0]).toEqual({
		auth_epoch: before.rows[0].auth_epoch + 1,
		policy_revoked: false,
	});
	expect(
		(
			await gateway.request(
				"POST",
				"/internal/v1/gateway/desktop/tickets/exchange",
				{ json: { ticket, label } },
			)
		).status,
	).toBe(401);
	expect(
		(await gateway.request("GET", `/internal/v1/gateway/routes/${label}`)).body,
	).toMatchObject({ blocked: false });
});

it("an operator block refuses desktop input, clipboard writes, links and access like exec", async () => {
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
	await db.pool.query("UPDATE runtime.sandboxes SET blocked=true WHERE id=$1", [
		s.sandboxId,
	]);
	const root = `/v1/sandboxes/${s.slug}/desktop`;
	const refused = [
		await h.request("POST", `${root}/actions`, {
			json: { actions: [{ type: "type", text: "id\n" }] },
		}),
		await h.request("PUT", `${root}/clipboard`, { json: { text: "x" } }),
		await h.request("POST", `${root}/links`),
		await h.request("PUT", `${root}/access`, { json: { access: "sso" } }),
	];
	for (const r of refused) {
		expect(r.status).toBe(403);
		expect(r.body).toMatchObject({
			error: { code: "forbidden", details: { reason: "sandbox_blocked" } },
		});
	}
	const tickets = await db.pool.query(
		"SELECT count(*)::int AS n FROM runtime.desktop_tickets WHERE sandbox_id=$1",
		[s.sandboxId],
	);
	expect(tickets.rows[0].n).toBe(0);
	expect((await h.request("GET", root)).status).toBe(200);
	expect((await h.request("GET", `${root}/screenshot`)).status).toBe(200);
	expect((await h.request("GET", `${root}/clipboard`)).status).toBe(200);
	expect((await h.request("DELETE", `${root}/streams`)).status).toBe(204);
});
