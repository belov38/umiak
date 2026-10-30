// Auth header handling over every operation of the public document (S7
// §2 anti-goal 4, §7.1, §7.4, §7.10, §16 "Безопасность"):
// - public: no bearer is 401 everywhere but the anonymous operations, and
//   oauth2-proxy headers (X-Auth-Request-*, X-Forwarded-User/Email) and
//   cookies never authenticate nor change who the caller is;
// - malformed or foreign bearers are 401, Sbx-Team of another team 403;
// - proxied: Authorization is refused, every unsafe operation needs the
//   dashboard Origin, a WebSocket upgrade with a foreign Origin is refused.
import { encodeUuid, generateApiKeySecret } from "@sbx/auth";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type ApiDeps, PTY_SUBPROTOCOL } from "../src/index.ts";
import { issueApiKey } from "../src/testing/index.ts";
import {
	createHarness,
	type Harness,
	type HarnessResponse,
} from "./helpers/harness.ts";
import { ROUTE_LIST } from "./helpers/route-table.ts";
import {
	type Any,
	buildFixture,
	errorOf,
	listen,
	newTeam,
	type Person,
	personOf,
	send,
	type TeamFixture,
} from "./helpers/security.ts";
import { testSshCa } from "./helpers/ssh.ts";
import { type ApiWorld, apiWorld } from "./helpers/world.ts";

const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"];

describe.skipIf(skipPg())("auth headers on every operation", () => {
	let db: TestDatabase;
	let w: ApiWorld;
	let deps: Partial<ApiDeps>;
	let owner: Person;
	let operator: Record<string, string>;
	let f: TeamFixture;
	/** Public listener without a default bearer. */
	let anon: Harness;

	beforeAll(async () => {
		db = await createTestDatabase({ max: 20 });
		w = await apiWorld(db.pool);
		deps = { sshCa: testSshCa() };
		owner = await personOf(w, w.teamId, "owner", deps);
		f = await buildFixture(w, w.teamId, w.harness({ deps }), owner);
		anon = createHarness({ deps: w.deps(deps) });
		// The identity of a platform operator, as oauth2-proxy would send it.
		operator = {
			...owner.headers,
			"x-auth-request-groups": "sbx-operators",
			"x-auth-request-preferred-username": "root",
			"x-forwarded-user": owner.headers["x-auth-request-user"] as string,
			"x-forwarded-email": owner.headers["x-auth-request-email"] as string,
		};
	});
	afterAll(async () => {
		await w?.close();
		await db?.drop();
	});

	const authenticated = ROUTE_LIST.filter(([, r]) => !r.anonymous);

	function expect401(r: HarnessResponse, where: string): void {
		expect(r.status, `${where}: ${r.text.slice(0, 300)}`).toBe(401);
		expect(r.headers.get("www-authenticate"), where).toMatch(
			/^Bearer realm="sbx"/,
		);
		if (r.text !== "") expect(errorOf(r).code, where).toBe("unauthorized");
	}

	it("public: no bearer is 401 on every authenticated operation, also with oauth2-proxy headers, cookies or a key in the query", async () => {
		for (const [id, r] of authenticated) {
			const req = r.request(f);
			expect401(await send(anon, r.method, req), `${id} bare`);
			const sep = req.path.includes("?") ? "&" : "?";
			expect401(
				await send(anon, r.method, {
					...req,
					path: `${req.path}${sep}access_token=${w.secret}&api_key=${w.secret}`,
				}),
				`${id} query`,
			);
			expect401(
				await send(anon, r.method, req, {
					...operator,
					cookie: "_oauth2_proxy=forged; __Host-session=forged",
				}),
				`${id} proxy headers`,
			);
		}
	});

	it("public: oauth2-proxy headers next to a team key change nothing", async () => {
		const h = w.harness({ deps });
		const plain = await h.request("GET", "/v1/me");
		const forged = await h.request("GET", "/v1/me", { headers: operator });
		expect(forged.status).toBe(200);
		expect(forged.body).toEqual(plain.body);
		expect((forged.body as Any).auth.kind).toBe("team_key");
		expect((forged.body as Any).isOperator).toBe(false);
		// Still a key: person-only operations refuse it.
		const ssh = await h.request("GET", "/v1/ssh-keys", { headers: operator });
		expect(ssh.status).toBe(403);
		expect(errorOf(ssh).details.reason).toBe("user_required");
	});

	it("public: malformed, unknown, reserved and revoked bearers are 401 on every operation", async () => {
		const revoked = await w.key([]);
		await w.identity.revokeApiKey(revoked.id, { apiKeyId: revoked.id });
		const bad: [string, string][] = [
			["basic scheme", `Basic ${Buffer.from("a:b").toString("base64")}`],
			["no token", "Bearer"],
			["two tokens", `Bearer ${w.secret} x`],
			// Two Authorization headers arrive joined by ", ".
			["two headers", `Bearer ${w.secret}, Bearer ${revoked.secret}`],
			["unknown key", `Bearer ${generateApiKeySecret()}`],
			[
				"broken CRC",
				`Bearer ${w.secret.slice(0, -1)}${w.secret.endsWith("A") ? "B" : "A"}`,
			],
			["sandbox key prefix", `Bearer sbxs_${w.secret.slice(4)}`],
			["not a JWT", "Bearer a.b.c"],
			["revoked key", `Bearer ${revoked.secret}`],
		];
		for (const [id, r] of authenticated) {
			for (const [name, authorization] of bad) {
				expect401(
					await send(anon, r.method, r.request(f), { authorization }),
					`${id} ${name}`,
				);
			}
		}
	});

	it("public: a key with Sbx-Team of another team is 403 team_forbidden on every operation", async () => {
		const other = encodeUuid("team", await newTeam(db.pool));
		const h = w.harness({ deps });
		for (const [id, r] of authenticated) {
			const res = await send(h, r.method, r.request(f), { "sbx-team": other });
			expect(res.status, id).toBe(403);
			if (r.method !== "HEAD")
				expect(errorOf(res).code, id).toBe("team_forbidden");
		}
	});

	it("a key of another team is not accepted for this team's resources (Sbx-Team of the fixture)", async () => {
		const otherKey = await issueApiKey(w.identity, {
			teamId: await newTeam(db.pool),
		});
		const h = w.harness({ bearer: otherKey.secret, deps });
		const res = await h.request("GET", `/v1/sandboxes/${f.sandbox}`, {
			headers: { "sbx-team": encodeUuid("team", f.teamId) },
		});
		expect(res.status).toBe(403);
		expect(errorOf(res).code).toBe("team_forbidden");
	});

	it("proxied: Authorization is refused (400) on every authenticated operation", async () => {
		for (const [id, r] of authenticated) {
			const res = await send(owner.h, r.method, r.request(f), {
				...owner.headers,
				authorization: `Bearer ${w.secret}`,
			});
			expect(res.status, id).toBe(400);
			if (r.method !== "HEAD") {
				expect(errorOf(res).details.issues[0].path, id).toBe(
					"header.authorization",
				);
			}
		}
	});

	it("proxied: every unsafe operation without Origin or with a foreign Origin is 403 origin_forbidden", async () => {
		const unsafe = authenticated.filter(([, r]) => UNSAFE.includes(r.method));
		expect(unsafe.length).toBeGreaterThan(40);
		for (const [id, r] of unsafe) {
			const { origin: _, ...noOrigin } = owner.headers;
			for (const headers of [
				noOrigin,
				{ ...noOrigin, origin: "https://evil.example" },
				{ ...noOrigin, origin: "null" },
				{ ...noOrigin, origin: `${owner.headers.origin}.evil.example` },
			]) {
				const res = await send(owner.h, r.method, r.request(f), headers);
				expect(res.status, `${id} ${headers.origin}`).toBe(403);
				expect(errorOf(res).code, id).toBe("origin_forbidden");
			}
		}
	});

	it("proxied: no X-Auth-Request-Email is 401 on every authenticated operation", async () => {
		const { "x-auth-request-email": _, ...headers } = owner.headers;
		for (const [id, r] of authenticated) {
			const res = await send(owner.h, r.method, r.request(f), headers);
			expect(res.status, id).toBe(401);
		}
	});

	it("proxied: a WebSocket upgrade with a foreign or no Origin is refused with 403 before the upgrade", async () => {
		const srv = await listen(owner.h.app);
		const path = `/v1/sandboxes/${f.sandbox}/ptys/${f.pty}/connect`;
		const { origin: _, ...noOrigin } = owner.headers;
		try {
			for (const headers of [
				{ ...noOrigin, origin: "https://evil.example" },
				noOrigin,
			]) {
				const ws = new WebSocket(`${srv.base}${path}`, [PTY_SUBPROTOCOL], {
					headers,
				});
				const refused = await new Promise<{ status: number; body: string }>(
					(resolve, reject) => {
						ws.once("open", () => reject(new Error("upgraded")));
						ws.once("unexpected-response", (_req, res) => {
							let body = "";
							res.on("data", (d: Buffer) => {
								body += d.toString();
							});
							res.on("end", () =>
								resolve({ status: res.statusCode ?? 0, body }),
							);
						});
						ws.once("error", () => {});
					},
				);
				expect(refused.status, headers.origin).toBe(403);
				expect(JSON.parse(refused.body).error.code).toBe("origin_forbidden");
			}
		} finally {
			await srv.close();
		}
	});

	it("internal: a team key, a person's headers or no token is 401", async () => {
		const h = createHarness({ listener: "internal", deps: w.deps(deps) });
		for (const headers of [
			{},
			{ authorization: `Bearer ${w.secret}` },
			owner.headers,
		]) {
			const res = await h.request("GET", "/internal/v1/gateway/routes/x-3000", {
				headers,
			});
			expect(res.status).toBe(401);
		}
	});
});
