import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "@umiak/db/testing";
import type { Payload } from "payload";
import { getConstructionPlans } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildUmiakConfig,
	migrateUmiakPayload,
	PAYLOAD_MIGRATIONS_DIR,
} from "../src/index.ts";
import { closePayload, openPayload, testOptions } from "./helpers.ts";

describe("buildUmiakConfig", () => {
	it("moves REST to /cms-api, disables GraphQL, pins CSRF and cookies", async () => {
		const c = await buildUmiakConfig(
			testOptions("postgres://u:p@127.0.0.1:1/x"),
		);
		expect(c.routes.api).toBe("/cms-api");
		expect(c.routes.admin).toBe("/admin");
		expect(c.graphQL.disable).toBe(true);
		expect(c.csrf).toEqual(["https://app.umiak.test"]);
		expect(c.cookiePrefix).toBe("__Host-payload");
		expect(c.admin.user).toBe("users");
		expect(c.admin.avatar).toBe("default");
		expect(c.admin.components?.graphics).toMatchObject({
			Logo: "/src/components/admin/brand#Logo",
			Icon: "/src/components/admin/brand#Icon",
		});
		expect(c.admin.meta.titleSuffix).toBe(" — Umiak");
		expect(c.telemetry).toBe(false);
		expect(c.custom).toEqual({
			umiak: { operatorGroups: ["umiak-operators"] },
		});
		const users = c.collections.find((x) => x.slug === "users");
		expect(users?.auth.disableLocalStrategy).toBe(true);
		expect(users?.auth.strategies.map((s) => s.name)).toEqual(["oauth2-proxy"]);
		expect(users?.fields.some((f) => "name" in f && f.name === "hash")).toBe(
			false,
		);
	});

	it("has no CSRF origin without appOrigin", async () => {
		const { appOrigin: _, ...o } = testOptions("postgres://u:p@127.0.0.1:1/x");
		expect((await buildUmiakConfig(o)).csrf).toEqual([]);
	});
});

describe.skipIf(skipPg())("payload schema", () => {
	let t: TestDatabase;
	let payload: Payload;

	beforeAll(async () => {
		// db/migrations (runtime, tunnel, identity) from the template, the
		// pg-boss schema as the worker creates it, then Payload.
		t = await createTestDatabase({ max: 2 });
		await t.pool.query(getConstructionPlans("pgboss"));
		payload = await openPayload(t.url);
		await migrateUmiakPayload(payload);
	});
	afterAll(async () => {
		if (t) await closePayload(t.url);
		await t?.drop();
	});

	async function names(
		kind: "table" | "enum",
		schemas: string[],
	): Promise<Set<string>> {
		const sql =
			kind === "table"
				? "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = ANY($1)"
				: `SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace
				   WHERE t.typtype = 'e' AND s.nspname = ANY($1)`;
		const r = await t.pool.query<{ n: string }>(sql, [schemas]);
		return new Set(r.rows.map((x) => x.n));
	}

	it("uses UUIDv7 ids in the payload schema", () => {
		expect(payload.db.idType).toBe("uuidv7");
		expect(payload.db.schemaName).toBe("payload");
	});

	it("has the tables of every collection and global", async () => {
		const tables = await names("table", ["payload"]);
		for (const n of [
			"users",
			"teams",
			"memberships",
			"api_keys",
			"team_notices",
			"ssh_keys",
			"templates",
			"sizes",
			"pool_targets",
			"platform_defaults",
			"payload_migrations",
		]) {
			expect(tables, n).toContain(n);
		}
	});

	it("shares no table or enum name with runtime, tunnel and pgboss", async () => {
		const others = ["runtime", "tunnel", "pgboss"];
		const otherTables = await names("table", others);
		expect(otherTables.size).toBeGreaterThan(10);
		expect(otherTables).toContain("job");
		const clashes = [...(await names("table", ["payload"]))].filter((n) =>
			otherTables.has(n),
		);
		expect(clashes).toEqual([]);
		const otherEnums = await names("enum", others);
		const enumClashes = [...(await names("enum", ["payload"]))].filter((n) =>
			otherEnums.has(n),
		);
		expect(enumClashes).toEqual([]);
	});

	it("has no drift: a migration generated from the config is empty", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "umiak-payload-drift-"));
		const saved = payload.db.migrationDir;
		await cp(PAYLOAD_MIGRATIONS_DIR, dir, { recursive: true });
		const before = (await readdir(dir)).sort();
		class Exit extends Error {
			code: number | undefined;
			constructor(code: number | undefined) {
				super(`process.exit(${code})`);
				this.code = code;
			}
		}
		// createMigration with skipEmpty exits the process when nothing changed.
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Exit(code === undefined ? undefined : Number(code));
		});
		try {
			payload.db.migrationDir = dir;
			const err = await Promise.resolve(
				payload.db.createMigration({
					migrationName: "drift",
					payload,
					skipEmpty: true,
				}),
			).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Exit);
			expect((err as Exit).code).toBe(0);
			expect((await readdir(dir)).sort()).toEqual(before);
		} finally {
			exit.mockRestore();
			payload.db.migrationDir = saved;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
