// ctl-idp-sync wiring (S8 §20.1, plan decision 9): env, the KeycloakIdpSync
// built from it, registration and the abort metrics.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, skipPg, type TestDatabase } from "@sbx/db/testing";
import { migrateSbxPayload } from "@sbx/payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerCtx } from "../src/context.ts";
import {
	activeControllers,
	type IdpSync,
	runIdpSync,
} from "../src/controllers/index.ts";
import { EnvError, parseWorkerEnv } from "../src/env.ts";
import { PromMetrics } from "../src/metrics.ts";
import {
	createWorkerIdpSync,
	openWorkerPayload,
	type WorkerPayload,
} from "../src/payload.ts";
import { testLogger } from "./helpers/worker.ts";

const BASE = {
	DATABASE_URL: "postgres://sbx:sbx@db:5432/sbx",
	PAYLOAD_SECRET: "payload-secret-0123456789abcdef",
	SBX_DATA_KEYS_FILE: "/etc/sbx/keys.json",
	SBX_SECRETS_DIR: "/etc/sbx/secrets",
};

const SECRET = "kc-client-secret-must-not-leak";

function ctxOf(metrics: PromMetrics, idpSync?: IdpSync) {
	const { log, captured } = testLogger("info");
	const ctx = {
		log,
		metrics,
		...(idpSync ? { idpSync } : {}),
	} as unknown as WorkerCtx;
	return { ctx, captured };
}

const fakePayload = {} as WorkerPayload["payload"];

describe("ctl-idp-sync env and registration", () => {
	it("without SBX_IDP_SYNC_KEYCLOAK_URL the controller is not registered", () => {
		const env = parseWorkerEnv(BASE);
		expect(env.idpSync).toBeUndefined();
		const { log } = testLogger("silent");
		const sync = createWorkerIdpSync({
			env: env.idpSync,
			payload: fakePayload,
			log,
		});
		expect(sync).toBeUndefined();
		const { ctx } = ctxOf(new PromMetrics(), sync);
		expect(activeControllers(ctx).map((c) => c.queue)).not.toContain(
			"ctl-idp-sync",
		);
	});

	it("the URL needs the client secret file; realm and client id default", () => {
		expect(() =>
			parseWorkerEnv({
				...BASE,
				SBX_IDP_SYNC_KEYCLOAK_URL: "http://keycloak:8080",
			}),
		).toThrow(EnvError);
		expect(() =>
			parseWorkerEnv({
				...BASE,
				SBX_IDP_SYNC_KEYCLOAK_URL: "http://keycloak:8080",
			}),
		).toThrow(/SBX_IDP_SYNC_CLIENT_SECRET_FILE/);
		expect(() =>
			parseWorkerEnv({
				...BASE,
				SBX_IDP_SYNC_KEYCLOAK_URL: "keycloak:8080",
				SBX_IDP_SYNC_CLIENT_SECRET_FILE: "/run/secrets/kc",
			}),
		).toThrow(/SBX_IDP_SYNC_KEYCLOAK_URL/);

		const env = parseWorkerEnv({
			...BASE,
			SBX_IDP_SYNC_KEYCLOAK_URL: "http://keycloak:8080",
			SBX_IDP_SYNC_CLIENT_SECRET_FILE: "/run/secrets/kc",
		});
		expect(env.idpSync).toEqual({
			keycloakUrl: "http://keycloak:8080",
			realm: "sbx",
			clientId: "sbx-worker",
			clientSecretFile: "/run/secrets/kc",
		});
		const custom = parseWorkerEnv({
			...BASE,
			SBX_IDP_SYNC_KEYCLOAK_URL: "https://id.example.com",
			SBX_IDP_SYNC_REALM: "corp",
			SBX_IDP_SYNC_CLIENT_ID: "sync",
			SBX_IDP_SYNC_CLIENT_SECRET_FILE: "/run/secrets/kc",
		}).idpSync;
		expect(custom).toMatchObject({ realm: "corp", clientId: "sync" });
	});

	it("with it ctl-idp-sync is registered; an empty secret file is refused", () => {
		const env = parseWorkerEnv({
			...BASE,
			SBX_IDP_SYNC_KEYCLOAK_URL: "http://keycloak:8080",
			SBX_IDP_SYNC_CLIENT_SECRET_FILE: "/run/secrets/kc",
		});
		const { log } = testLogger("silent");
		const sync = createWorkerIdpSync({
			env: env.idpSync,
			payload: fakePayload,
			log,
			readFile: () => `${SECRET}\n`,
		});
		expect(sync).toBeDefined();
		const { ctx } = ctxOf(new PromMetrics(), sync);
		expect(activeControllers(ctx).map((c) => c.queue)).toContain(
			"ctl-idp-sync",
		);
		expect(() =>
			createWorkerIdpSync({
				env: env.idpSync,
				payload: fakePayload,
				log,
				readFile: () => " \n",
			}),
		).toThrow(/is empty/);
	});

	it("sbx_idp_sync_aborted: 1 after an abort (plus the counter and log.error), 0 after a pass", async () => {
		const m = new PromMetrics();
		const text0 = await m.registry.metrics();
		expect(text0).toContain("# TYPE sbx_idp_sync_aborted gauge");
		expect(text0).toContain("# TYPE sbx_idp_sync_aborted_total counter");

		let aborted = true;
		const { ctx, captured } = ctxOf(m, {
			run: async () =>
				aborted
					? {
							aborted: true,
							abort: {
								reason: "mass_deactivation",
								wouldDeactivate: 10,
								active: 10,
							},
							deactivated: [],
							reactivated: [],
						}
					: { aborted: false, deactivated: [], reactivated: [] },
		});
		await runIdpSync(ctx, ctx.idpSync as IdpSync);
		let text = await m.registry.metrics();
		expect(text).toMatch(/^sbx_idp_sync_aborted 1$/m);
		expect(text).toContain(
			'sbx_idp_sync_aborted_total{reason="mass_deactivation"} 1',
		);
		const err = captured.lines
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.find((l) => l.msg === "idp sync aborted: nothing changed");
		expect(err).toMatchObject({
			level: 50,
			reason: "mass_deactivation",
			wouldDeactivate: 10,
			active: 10,
		});

		aborted = false;
		await runIdpSync(ctx, ctx.idpSync as IdpSync);
		text = await m.registry.metrics();
		expect(text).toMatch(/^sbx_idp_sync_aborted 0$/m);
		expect(text).toContain(
			'sbx_idp_sync_aborted_total{reason="mass_deactivation"} 1',
		);
	});
});

describe.skipIf(skipPg())(
	"ctl-idp-sync over Payload and a fake Keycloak",
	() => {
		let db: TestDatabase;
		let wp: WorkerPayload | undefined;
		let server: Server;
		let kcUsers: { id: string; enabled: boolean }[] = [];
		let kcUrl: string;

		beforeAll(async () => {
			db = await createTestDatabase();
			server = createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://kc");
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					const json = (status: number, body: unknown) => {
						res.writeHead(status, { "content-type": "application/json" });
						res.end(JSON.stringify(body));
					};
					if (url.pathname === "/realms/sbx/protocol/openid-connect/token") {
						const f = new URLSearchParams(Buffer.concat(chunks).toString());
						if (
							f.get("client_id") !== "sbx-worker" ||
							f.get("client_secret") !== SECRET
						) {
							return json(401, {});
						}
						return json(200, { access_token: "tok", expires_in: 300 });
					}
					if (req.headers.authorization !== "Bearer tok") return json(401, {});
					if (url.pathname === "/admin/realms/sbx/users") {
						const first = Number(url.searchParams.get("first"));
						const max = Number(url.searchParams.get("max"));
						return json(200, kcUsers.slice(first, first + max));
					}
					json(404, {});
				});
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			kcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});
		afterAll(async () => {
			await new Promise<void>((r) => server?.close(() => r()));
			await wp?.close();
			await db?.drop();
		});

		it("an empty Keycloak list aborts (gauge 1); the full list passes (gauge 0)", async () => {
			const { log } = testLogger("silent");
			wp = await openWorkerPayload({
				databaseUrl: db.url,
				secret: "worker-payload-secret-0123456789",
				log,
			});
			await migrateSbxPayload(wp.payload, () => {});
			const subs: string[] = [];
			for (let i = 0; i < 6; i++) {
				const sub = randomUUID();
				subs.push(sub);
				await wp.payload.create({
					collection: "users",
					data: { email: `w-${sub}@example.com`, idpSubject: sub },
					depth: 0,
				});
			}
			const dir = mkdtempSync(join(tmpdir(), "idp-sync-"));
			const secretFile = join(dir, "secret");
			writeFileSync(secretFile, `${SECRET}\n`);
			const env = parseWorkerEnv({
				...BASE,
				SBX_IDP_SYNC_KEYCLOAK_URL: kcUrl,
				SBX_IDP_SYNC_CLIENT_SECRET_FILE: secretFile,
			});
			const sync = createWorkerIdpSync({
				env: env.idpSync,
				payload: wp.payload,
				log,
			});
			const m = new PromMetrics();
			const { ctx, captured } = ctxOf(m, sync);
			const ctl = activeControllers(ctx).find(
				(c) => c.queue === "ctl-idp-sync",
			);
			expect(ctl).toBeDefined();

			kcUsers = [];
			await ctl?.run(ctx);
			expect(await m.registry.metrics()).toMatch(/^sbx_idp_sync_aborted 1$/m);
			const users = await wp.payload.find({
				collection: "users",
				where: { idpSubject: { in: subs } },
				depth: 0,
				pagination: false,
			});
			expect(users.docs.every((u) => u.active === true)).toBe(true);

			kcUsers = subs.map((id) => ({ id, enabled: true }));
			await ctl?.run(ctx);
			expect(await m.registry.metrics()).toMatch(/^sbx_idp_sync_aborted 0$/m);
			expect(captured.text()).not.toContain(SECRET);
		});
	},
);
