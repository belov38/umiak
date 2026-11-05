// Production dependencies on Payload (S8 plan decision 5): `buildDeps` takes
// identities and config from Payload (PayloadIdentityStore,
// PayloadConfigReader), loads UMIAK_IDENTITY_FILE into Payload, and `/readyz`
// reports `payload_migrations` while the Payload schema is behind the code.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiKeyHash, generateApiKeySecret } from "@umiak/auth";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import {
	closeUmiakPayload,
	getUmiakPayload,
	migrateUmiakPayload,
	PayloadConfigReader,
	PayloadIdentityStore,
} from "@umiak/payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ApiDeps,
	buildDeps,
	createApiLogger,
	createOpsApp,
	createProxiedApp,
	createPublicApp,
	type ProductionDeps,
} from "../src/index.ts";
import { testSettings } from "../src/testing/index.ts";

const TEAM_ID = "00000000-0000-4000-8000-0000000000c1";
const PAYLOAD_SECRET = "api-payload-secret-0123456789abcdef";

const log = createApiLogger({ level: "silent" });

function files(identityYaml: string | null): Record<string, string> {
	const dir = mkdtempSync(join(tmpdir(), "umiak-api-payload-"));
	const file = (name: string, text: string) => {
		const p = join(dir, name);
		writeFileSync(p, text);
		return p;
	};
	return {
		UMIAK_DATA_KEYS_FILE: file(
			"data-keys.json",
			JSON.stringify({
				current: 1,
				keys: { "1": Buffer.alloc(32, 5).toString("base64") },
			}),
		),
		UMIAK_API_SERVICE_TOKENS_FILE: file(
			"service-tokens.json",
			JSON.stringify({ gateway: ["gw-token-payload-0123456789"] }),
		),
		...(identityYaml === null
			? {}
			: { UMIAK_IDENTITY_FILE: file("identity.yaml", identityYaml) }),
	};
}

async function until(fn: () => Promise<boolean>, what: string): Promise<void> {
	const end = Date.now() + 10_000;
	while (!(await fn())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(skipPg())("buildDeps on Payload", () => {
	describe("with the Payload migrations applied", () => {
		let db: TestDatabase;
		let built: ProductionDeps | undefined;
		let deps: ApiDeps;
		const secret = generateApiKeySecret();

		beforeAll(async () => {
			db = await createTestDatabase();
			const p = await getUmiakPayload({
				databaseUrl: db.url,
				secret: PAYLOAD_SECRET,
				operatorGroups: [],
				poolMax: 4,
			});
			await migrateUmiakPayload(p, () => {});
			await closeUmiakPayload(db.url);
			const settings = testSettings({
				DATABASE_URL: db.url,
				PAYLOAD_SECRET,
				UMIAK_OPERATOR_GROUPS: "umiak-operators",
				...files(
					[
						"teams:",
						`  - {id: ${TEAM_ID}, name: payload-team}`,
						"apiKeys:",
						"  - id: 00000000-0000-4000-8000-0000000000c2",
						`    teamId: ${TEAM_ID}`,
						"    name: seeded",
						`    sha256: ${apiKeyHash(secret)}`,
						"    preset: full",
						"    expiresAt: 2099-01-01T00:00:00Z",
						"",
					].join("\n"),
				),
			});
			built = await buildDeps(settings, log);
			deps = built.deps;
		});
		afterAll(async () => {
			await built?.dispose();
			await db?.drop();
		});

		it("identity and config are the Payload ones", () => {
			expect(deps.identity).toBeInstanceOf(PayloadIdentityStore);
			expect(deps.config).toBeInstanceOf(PayloadConfigReader);
		});

		it("the identity file is loaded into Payload: its key answers /v1/me", async () => {
			const r = await createPublicApp(deps).request(
				"/v1/me",
				{
					headers: {
						host: new URL(deps.settings.apiUrl).host,
						authorization: `Bearer ${secret}`,
					},
				},
				{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
			);
			expect(r.status).toBe(200);
			expect(await r.json()).toMatchObject({ team: { name: "payload-team" } });
			const rows = await db.pool.query<{ name: string }>(
				"SELECT name FROM payload.teams WHERE id = $1",
				[TEAM_ID],
			);
			expect(rows.rows).toEqual([{ name: "payload-team" }]);
		});

		it("/v1/templates serves the Payload seed (linux and windows) and follows a change", async () => {
			const app = createPublicApp(deps);
			const get = async () => {
				const r = await app.request(
					"/v1/templates",
					{
						headers: {
							host: new URL(deps.settings.apiUrl).host,
							authorization: `Bearer ${secret}`,
						},
					},
					{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
				);
				expect(r.status).toBe(200);
				return ((await r.json()) as { data: { slug: string; name: string }[] })
					.data;
			};
			expect((await get()).map((t) => t.slug)).toEqual([
				"linux",
				"windows",
				"linux-desktop",
			]);
			// A change through Payload reaches the cached reader (LISTEN umiak_config).
			const payload = await getUmiakPayload({
				databaseUrl: db.url,
				secret: PAYLOAD_SECRET,
				operatorGroups: [],
			});
			try {
				await payload.update({
					collection: "templates",
					where: { slug: { equals: "linux" } },
					data: { name: "Linux (Payload)" },
					overrideAccess: true,
				});
			} finally {
				// Releases this reference only: buildDeps keeps its own.
				await closeUmiakPayload(db.url);
			}
			await until(
				async () => (await get())[0]?.name === "Linux (Payload)",
				"the renamed template",
			);
		});

		it("a browser session is resolved by Payload (JIT user)", async () => {
			const r = await createProxiedApp(deps).request(
				"/v1/me",
				{
					headers: {
						host: new URL(deps.settings.apiUrl).host,
						"x-auth-request-email": "jit@example.com",
						"x-auth-request-user": "sub-jit",
					},
				},
				{ incoming: { socket: { remoteAddress: "127.0.0.1" } } },
			);
			expect(r.status).toBe(200);
			const rows = await db.pool.query<{ email: string }>(
				"SELECT email FROM payload.users WHERE idp_subject = 'umiak:local'",
			);
			expect(rows.rows).toEqual([{ email: "local@umiak.invalid" }]);
		});

		it("/readyz is 200", async () => {
			const r = await createOpsApp(deps).request("/readyz");
			expect(r.status).toBe(200);
			expect(await r.json()).toEqual({ ready: true, reasons: [] });
		});
	});

	describe("without the Payload migrations", () => {
		let db: TestDatabase;
		let built: ProductionDeps | undefined;

		beforeAll(async () => {
			db = await createTestDatabase();
		});
		afterAll(async () => {
			await built?.dispose();
			await db?.drop();
		});

		it("/readyz is 503 with reason payload_migrations", async () => {
			built = await buildDeps(
				testSettings({ DATABASE_URL: db.url, PAYLOAD_SECRET, ...files(null) }),
				log,
			);
			const r = await createOpsApp(built.deps).request("/readyz");
			expect(r.status).toBe(503);
			expect(await r.json()).toMatchObject({
				error: {
					code: "not_ready",
					retryable: true,
					details: { reasons: ["payload_migrations"] },
				},
			});
		});

		it("with an identity file the start fails and names the migrations", async () => {
			await built?.dispose();
			built = undefined;
			await expect(
				buildDeps(
					testSettings({
						DATABASE_URL: db.url,
						PAYLOAD_SECRET,
						...files("teams: []\n"),
					}),
					log,
				),
			).rejects.toThrow(/payload migrations not applied/);
		});
	});
});
