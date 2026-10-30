// SSO for ports (S7 §7.7, §12.1, S4 §8.4, S8 C7): the browser endpoint
// /sbx-auth/authorize on the proxied listener issues a one-time code, the
// gateway exchanges it once on the internal listener.
import { createHash, randomUUID } from "node:crypto";
import { encodeUuid } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceTokens } from "../src/index.ts";
import { testIdentityStore } from "../src/testing/index.ts";
import { mutableDefaults } from "./helpers/config.ts";
import {
	createHarness,
	type Harness,
	type HarnessResponse,
} from "./helpers/harness.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

// biome-ignore lint/suspicious/noExplicitAny: internal answers are not in the document
type Body = any;
const body = (r: HarnessResponse): Body => r.body as Body;

const GW = "gw-token-sso-0123456789abcdef";
const STATE = "AbCdEfGhIjKlMnOpQrStUv";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

describe.skipIf(skipPg())(
	"port SSO: /sbx-auth/authorize and port-auth/exchange",
	() => {
		let db: TestDatabase;
		let w: ApiWorld;
		let gw: Harness;
		let defaults: ReturnType<typeof mutableDefaults>;

		beforeAll(async () => {
			db = await createTestDatabase({ max: 20 });
			w = await apiWorld(db.pool);
			defaults = mutableDefaults(w.env.config);
			gw = w.harness({
				listener: "internal",
				bearer: GW,
				deps: { serviceTokens: new ServiceTokens({ gateway: [GW] }) },
			});
		});
		afterAll(async () => {
			await w?.close();
			await db?.drop();
		});

		interface Browser {
			h: Harness;
			headers: Record<string, string>;
			userId: string;
			email: string;
		}

		/** A browser session (in-memory identity): a member of the world's team by default. */
		async function browser(
			o: { member?: boolean; operator?: boolean; active?: boolean } = {},
		): Promise<Browser> {
			const sub = `sub-${randomUUID()}`;
			const email = `${sub}@example.com`;
			const teams =
				(o.member ?? true)
					? [{ teamId: w.teamId, name: "world", role: "member" as const }]
					: [{ teamId: randomUUID(), name: "own", role: "owner" as const }];
			const identity = testIdentityStore({
				sessions: [
					{
						sub,
						teams,
						isOperator: o.operator ?? false,
						active: o.active ?? true,
					},
				],
			});
			const userId =
				o.active === false
					? ""
					: (await identity.resolveSession({ email, user: sub, groups: [] }))
							.user.id;
			const h = createHarness({
				listener: "proxied",
				deps: w.deps({ identity, config: defaults.config }),
			});
			return {
				h,
				headers: { "x-auth-request-email": email, "x-auth-request-user": sub },
				userId,
				email,
			};
		}

		const authorize = (
			b: Browser,
			query: string,
			headers: Record<string, string> = {},
		) =>
			b.h.request("GET", `/sbx-auth/authorize?${query}`, {
				headers: { ...b.headers, ...headers },
			});

		const exchange = (json: unknown) =>
			gw.request("POST", "/internal/v1/gateway/port-auth/exchange", { json });

		async function hosted(mode: "token" | "sso" | "public", port = 3000) {
			const s = await w.seed({ state: "ready" });
			await w.env.svc.hostPort(w.env.p, s.sandboxId, port, mode);
			return { ...s, label: `${s.slug}-${port}` };
		}

		async function epoch(sandboxId: string): Promise<number> {
			const r = await db.pool.query<{ auth_epoch: number }>(
				"SELECT auth_epoch FROM runtime.hosted_ports WHERE sandbox_id = $1 AND deleted_at IS NULL",
				[sandboxId],
			);
			return r.rows[0]?.auth_epoch as number;
		}

		/** The code of a 302 to the callback, checked against the label. */
		function codeOf(r: HarnessResponse, label: string): string {
			expect(r.status, r.text).toBe(302);
			const loc = new URL(r.headers.get("location") ?? "");
			expect(`${loc.origin}${loc.pathname}`).toBe(
				`https://${label}.${gw.deps.settings.sbxDomain}/__sbx/auth/callback`,
			);
			expect(loc.searchParams.get("state")).toBe(STATE);
			const code = loc.searchParams.get("code") ?? "";
			expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
			return code;
		}

		function expectErrorPage(r: HarnessResponse, status: number) {
			expect(r.status, r.text).toBe(status);
			expect(r.headers.get("location")).toBeNull();
			expect(r.headers.get("content-type")).toMatch(/^text\/html/);
			expect(r.text).toMatch(/^<!doctype html>/i);
			// Self-contained: no scripts, styles or images from anywhere.
			expect(r.text).not.toMatch(/<script|<link|<img|src=|https?:\/\//i);
		}

		describe("/sbx-auth/authorize", () => {
			it("redirects to the callback of the label's host, not the request's Host; stores only the hash", async () => {
				const r0 = await hosted("sso");
				defaults.set({ ssoPolicyEpoch: 3 });
				try {
					const b = await browser();
					const before = Date.now();
					const r = await authorize(b, `label=${r0.label}&state=${STATE}`, {
						host: "evil.example.com",
						"x-forwarded-host": "evil.example.com",
					});
					const code = codeOf(r, r0.label);
					expect(r.headers.get("cache-control")).toBe("no-store");
					expect(r.headers.get("referrer-policy")).toBe("no-referrer");
					const rows = await db.pool.query(
						"SELECT label, user_id, email, auth_epoch, expires_at, used_at FROM runtime.port_auth_codes WHERE code_hash = $1",
						[sha256(code)],
					);
					expect(rows.rows).toHaveLength(1);
					const row = rows.rows[0];
					expect(row).toMatchObject({
						label: r0.label,
						user_id: b.userId,
						email: b.email,
						auth_epoch: (await epoch(r0.sandboxId)) + 3,
						used_at: null,
					});
					const ttl = (row.expires_at as Date).getTime() - before;
					expect(ttl).toBeGreaterThan(55_000);
					expect(ttl).toBeLessThan(65_000);
					const raw = await db.pool.query(
						"SELECT 1 FROM runtime.port_auth_codes t WHERE strpos(row_to_json(t)::text, $1) > 0",
						[code],
					);
					expect(raw.rowCount).toBe(0);
				} finally {
					defaults.set({ ssoPolicyEpoch: 0 });
				}
			});

			it("a token or public port: an error page, no redirect, no code", async () => {
				for (const mode of ["token", "public"] as const) {
					const r0 = await hosted(mode);
					const r = await authorize(
						await browser(),
						`label=${r0.label}&state=${STATE}`,
					);
					expectErrorPage(r, 400);
					const n = await db.pool.query(
						"SELECT 1 FROM runtime.port_auth_codes WHERE label = $1",
						[r0.label],
					);
					expect(n.rowCount).toBe(0);
				}
			});

			it("a blocked sso port is 403; unknown, deleted and desktop labels are 404; a label outside the grammar is 400", async () => {
				const blocked = await hosted("sso");
				await db.pool.query(
					"UPDATE runtime.hosted_ports SET blocked = true, block_reason = 'operator' WHERE sandbox_id = $1",
					[blocked.sandboxId],
				);
				const b = await browser();
				expectErrorPage(
					await authorize(b, `label=${blocked.label}&state=${STATE}`),
					403,
				);
				const deleted = await hosted("sso");
				await w.markState(deleted.sandboxId, "deleted");
				for (const label of [
					"unknown-box-3000",
					deleted.label,
					`${deleted.slug}-desktop`,
				]) {
					expectErrorPage(
						await authorize(b, `label=${label}&state=${STATE}`),
						404,
					);
				}
				for (const label of [
					"x",
					"Box-3000",
					"api-3000",
					"a.b-3000",
					"box-0",
				]) {
					expectErrorPage(
						await authorize(
							b,
							`label=${encodeURIComponent(label)}&state=${STATE}`,
						),
						400,
					);
				}
			});

			it("missing or malformed label or state is 400", async () => {
				const r0 = await hosted("sso");
				const b = await browser();
				for (const q of [
					`state=${STATE}`,
					`label=${r0.label}`,
					`label=${r0.label}&state=`,
					`label=${r0.label}&state=${encodeURIComponent("a b<script>")}`,
					`label=${r0.label}&state=${"x".repeat(129)}`,
				]) {
					expectErrorPage(await authorize(b, q), 400);
				}
			});

			it("policy any lets in any signed-in user; team only members and operators", async () => {
				const r0 = await hosted("sso");
				const q = `label=${r0.label}&state=${STATE}`;
				const outsider = await browser({ member: false });
				codeOf(await authorize(outsider, q), r0.label);
				defaults.set({ ssoPortPolicy: "team" });
				try {
					expectErrorPage(await authorize(outsider, q), 403);
					codeOf(await authorize(await browser(), q), r0.label);
					codeOf(
						await authorize(
							await browser({ member: false, operator: true }),
							q,
						),
						r0.label,
					);
				} finally {
					defaults.set({ ssoPortPolicy: "any" });
				}
			});

			it("no session or a deactivated user: an error page, no redirect", async () => {
				const r0 = await hosted("sso");
				const b = await browser();
				const r = await b.h.request(
					"GET",
					`/sbx-auth/authorize?label=${r0.label}&state=${STATE}`,
				);
				expectErrorPage(r, 401);
				const off = await browser({ active: false });
				expectErrorPage(
					await authorize(off, `label=${r0.label}&state=${STATE}`),
					403,
				);
			});

			it("exists only on the proxied listener", async () => {
				const r0 = await hosted("sso");
				const r = await w
					.harness()
					.request(
						"GET",
						`/sbx-auth/authorize?label=${r0.label}&state=${STATE}`,
					);
				expect(r.status).toBe(404);
			});
		});

		describe("port-auth/exchange", () => {
			async function issued() {
				const r0 = await hosted("sso");
				const b = await browser();
				const code = codeOf(
					await authorize(b, `label=${r0.label}&state=${STATE}`),
					r0.label,
				);
				return { r0, b, code };
			}

			it("burns the code once: {userId, email, label, authEpoch}, then invalid_code", async () => {
				const { r0, b, code } = await issued();
				const r = await exchange({ code, label: r0.label });
				expect(r.status, r.text).toBe(200);
				expect(body(r)).toEqual({
					userId: encodeUuid("user", b.userId),
					email: b.email,
					label: r0.label,
					authEpoch: await epoch(r0.sandboxId),
				});
				const again = await exchange({ code, label: r0.label });
				expect(again.status).toBe(400);
				expect(body(again)).toMatchObject({
					code: "invalid_code",
					error: { code: "invalid_code", retryable: false },
				});
			});

			it("another label is invalid_code and does not burn the code", async () => {
				const { r0, code } = await issued();
				const other = await hosted("sso");
				const r = await exchange({ code, label: other.label });
				expect(r.status).toBe(400);
				expect(body(r).code).toBe("invalid_code");
				expect((await exchange({ code, label: r0.label })).status).toBe(200);
				expect(body(await exchange({ code, label: other.label })).code).toBe(
					"invalid_code",
				);
			});

			it("an expired code is invalid_code", async () => {
				const { r0, code } = await issued();
				await db.pool.query(
					"UPDATE runtime.port_auth_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1",
					[sha256(code)],
				);
				const r = await exchange({ code, label: r0.label });
				expect(r.status).toBe(400);
				expect(body(r).code).toBe("invalid_code");
			});

			it("an unknown or empty code is invalid_code; a malformed body is 400 validation", async () => {
				const r0 = await hosted("sso");
				for (const code of ["", "nope", "x".repeat(43)]) {
					const r = await exchange({ code, label: r0.label });
					expect(body(r).code, code).toBe("invalid_code");
				}
				for (const json of [
					{ label: r0.label },
					{ code: 1, label: r0.label },
				]) {
					const r = await exchange(json);
					expect(r.status).toBe(400);
					expect(body(r).code).toBe("validation");
				}
			});
		});
	},
);
