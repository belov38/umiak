// The api process (S7 §7.1, Task 15): `startApi` builds the production
// dependencies from the settings (Postgres pool, LISTEN umiak_identity,
// pg-boss sender, Payload identity and config, key ring, identity file,
// service tokens, SSH CA and host keys) and serves the four listeners; `onShutdownSignals` turns
// SIGTERM/SIGINT into one graceful close and the exit code.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect, createServer } from "node:net";
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
} from "@umiak/payload";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onShutdownSignals, type RunningApi, startApi } from "../src/index.ts";
import { testSettings } from "../src/testing/index.ts";
import { ed25519PublicKey } from "./helpers/ssh.ts";

const TEAM_ID = "00000000-0000-4000-8000-0000000000a1";
const GW = "gw-token-main-0123456789abcdef";

function refused(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect(port, "127.0.0.1");
		s.once("connect", () => {
			s.destroy();
			resolve(false);
		});
		s.once("error", () => resolve(true));
	});
}

describe.skipIf(skipPg())("startApi with production dependencies", () => {
	let db: TestDatabase;
	let dir: string;
	let env: Record<string, string>;
	const secret = generateApiKeySecret();
	const hostKey = ed25519PublicKey();

	beforeAll(async () => {
		db = await createTestDatabase();
		const payloadSecret = "main-test-payload-secret-0123456789";
		const p = await getUmiakPayload({
			databaseUrl: db.url,
			secret: payloadSecret,
			operatorGroups: [],
			poolMax: 4,
		});
		await migrateUmiakPayload(p, () => {});
		await closeUmiakPayload(db.url);
		dir = mkdtempSync(join(tmpdir(), "umiak-api-main-"));
		const file = (name: string, text: string) => {
			const p = join(dir, name);
			writeFileSync(p, text);
			return p;
		};
		env = {
			DATABASE_URL: db.url,
			PAYLOAD_SECRET: payloadSecret,
			UMIAK_DATA_KEYS_FILE: file(
				"data-keys.json",
				JSON.stringify({
					current: 1,
					keys: { "1": Buffer.alloc(32, 3).toString("base64") },
				}),
			),
			UMIAK_API_SERVICE_TOKENS_FILE: file(
				"service-tokens.json",
				JSON.stringify({ gateway: [GW] }),
			),
			UMIAK_API_GATEWAY_TOKEN_FILE: file("gateway-token", "outbound-token\n"),
			UMIAK_SSH_HOST_KEYS_FILE: file("host-keys.pub", `${hostKey}\n`),
			UMIAK_IDENTITY_FILE: file(
				"identity.yaml",
				[
					"teams:",
					`  - {id: ${TEAM_ID}, name: main-test}`,
					"apiKeys:",
					`  - id: 00000000-0000-4000-8000-0000000000b1`,
					`    teamId: ${TEAM_ID}`,
					"    name: seeded",
					`    sha256: ${apiKeyHash(secret)}`,
					"    preset: full",
					"    expiresAt: 2099-01-01T00:00:00Z",
					"",
				].join("\n"),
			),
			UMIAK_API_PUBLIC_PORT: "0",
			UMIAK_API_PROXIED_PORT: "0",
			UMIAK_API_INTERNAL_PORT: "0",
			UMIAK_API_METRICS_PORT: "0",
			UMIAK_LOG_LEVEL: "silent",
		};
	});
	afterAll(async () => {
		await db?.drop();
	});

	async function start(over: Record<string, string> = {}): Promise<RunningApi> {
		return startApi(testSettings({ ...env, ...over }), undefined, {
			host: "127.0.0.1",
		});
	}

	it("serves four ports: /readyz 200, /v1/meta 200 on public and proxied, internal needs a token; close frees the ports", async () => {
		const api = await start();
		const { ports } = api;
		try {
			const all = [ports.public, ports.proxied, ports.internal, ports.metrics];
			expect(new Set(all).size).toBe(4);
			for (const p of all) expect(p).toBeGreaterThan(0);
			const url = (port: number | null, path: string) =>
				`http://127.0.0.1:${port}${path}`;

			const ready = await fetch(url(ports.metrics, "/readyz"));
			expect(ready.status).toBe(200);
			expect(await ready.json()).toEqual({ ready: true, reasons: [] });

			for (const p of [ports.public, ports.proxied]) {
				const meta = await fetch(url(p, "/v1/meta"));
				expect(meta.status).toBe(200);
				const body = (await meta.json()) as Record<string, unknown>;
				expect(body).toMatchObject({ apiVersion: "v1", oidc: null });
				expect((body.ssh as { hostKeys: string[] }).hostKeys).toEqual([
					hostKey.split(" ").slice(0, 2).join(" "),
				]);
			}

			const internal = await fetch(url(ports.internal, "/internal/v1/x"));
			expect(internal.status).toBe(401);
			const withToken = await fetch(url(ports.internal, "/internal/v1/x"), {
				headers: { authorization: `Bearer ${GW}` },
			});
			expect(withToken.status).toBe(404);

			// The identity file was seeded at start: its team key works.
			const me = await fetch(url(ports.public, "/v1/me"), {
				headers: { authorization: `Bearer ${secret}` },
			});
			expect(me.status).toBe(200);
			expect(await me.json()).toMatchObject({
				team: { name: "main-test" },
			});

			const metrics = await fetch(url(ports.metrics, "/metrics"));
			expect(await metrics.text()).toContain("umiak_api_requests_total");
		} finally {
			await api.close();
		}
		for (const p of [
			ports.public,
			ports.proxied,
			ports.internal,
			ports.metrics,
		]) {
			expect(await refused(p as number)).toBe(true);
		}
	});

	it("UMIAK_API_PROXIED_ENABLED=0: no proxied listener", async () => {
		const api = await start({ UMIAK_API_PROXIED_ENABLED: "0" });
		try {
			expect(api.ports.proxied).toBeNull();
			const meta = await fetch(`http://127.0.0.1:${api.ports.public}/v1/meta`);
			expect(meta.status).toBe(200);
		} finally {
			await api.close();
		}
	});

	it("a broken file fails the start before anything connects", async () => {
		const bad = join(dir, "bad-tokens.json");
		writeFileSync(bad, "{");
		// A stand-in database that counts the connections of this start: a
		// Postgres startup message naming this test's database. Other clients
		// that still retry an ephemeral port this server reuses do not count.
		const dbName = `broken_${randomUUID().replaceAll("-", "")}`;
		let connections = 0;
		const fakeDb = createServer((s) => {
			let seen = Buffer.alloc(0);
			s.on("data", (b: Buffer) => {
				seen = Buffer.concat([seen, b]);
				if (seen.includes(dbName)) {
					connections++;
					s.destroy();
				}
			});
			s.on("error", () => {});
			s.setTimeout(2_000, () => s.destroy());
		});
		await new Promise<void>((r) => fakeDb.listen(0, "127.0.0.1", r));
		const port = (fakeDb.address() as AddressInfo).port;
		try {
			await expect(
				start({
					UMIAK_API_SERVICE_TOKENS_FILE: bad,
					DATABASE_URL: `postgres://umiak:umiak@127.0.0.1:${port}/${dbName}`,
				}),
			).rejects.toThrow(/service tokens file/);
			// Give a pool or LISTEN connection that might have started time to arrive.
			await new Promise((r) => setTimeout(r, 500));
			expect(connections).toBe(0);
		} finally {
			await new Promise((r) => fakeDb.close(r));
		}
	});
});

describe("onShutdownSignals", () => {
	function setup(close: () => Promise<void>) {
		const proc = new EventEmitter();
		const exits: number[] = [];
		let closes = 0;
		onShutdownSignals(proc, {
			close: () => {
				closes++;
				return close();
			},
			exit: (code) => void exits.push(code),
		});
		return { proc, exits, closes: () => closes };
	}

	it("SIGTERM closes once and exits 0; a second signal exits 1 at once", async () => {
		let release!: () => void;
		const s = setup(() => new Promise<void>((r) => (release = r)));
		s.proc.emit("SIGTERM");
		expect(s.closes()).toBe(1);
		expect(s.exits).toEqual([]);
		s.proc.emit("SIGINT");
		expect(s.closes()).toBe(1);
		expect(s.exits).toEqual([1]);
		release();
		await new Promise((r) => setImmediate(r));
		expect(s.exits).toEqual([1, 0]);
	});

	it("a failing close exits 1", async () => {
		const s = setup(() => Promise.reject(new Error("boom")));
		s.proc.emit("SIGINT");
		await new Promise((r) => setImmediate(r));
		expect(s.exits).toEqual([1]);
	});
});
