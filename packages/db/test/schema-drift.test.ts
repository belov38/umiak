import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "../src/index.ts";
import {
	createTestDatabase,
	skipPg,
	type TestDatabase,
} from "../src/testing/index.ts";

// Drizzle SQL type -> information_schema.columns.udt_name.
const UDT: Record<string, string> = {
	uuid: "uuid",
	text: "text",
	smallint: "int2",
	integer: "int4",
	bigint: "int8",
	boolean: "bool",
	jsonb: "jsonb",
	bytea: "bytea",
	"timestamp with time zone": "timestamptz",
};

function udtOf(sqlType: string): string {
	if (sqlType.endsWith("[]")) return `_${udtOf(sqlType.slice(0, -2))}`;
	return UDT[sqlType] ?? `unmapped:${sqlType}`;
}

interface Col {
	udt: string;
	nullable: boolean;
}

const tables = Object.values(schema).map((t) => getTableConfig(t as PgTable));

describe("drizzle schema", () => {
	it("covers both schemas and every table of the data model", () => {
		const names = tables.map((t) => `${t.schema}.${t.name}`).sort();
		expect(names).toEqual(
			[
				"runtime.providers",
				"runtime.nodes",
				"runtime.node_build_jobs",
				"runtime.storages",
				"runtime.template_builds",
				"runtime.volume_transfers",
				"runtime.move_reservations",
				"runtime.start_queue",
				"runtime.vmid_leases",
				"runtime.machines",
				"runtime.disks",
				"runtime.snapshots",
				"runtime.sandboxes",
				"runtime.sandbox_secrets",
				"runtime.sandbox_events",
				"runtime.operations",
				"runtime.idempotency_keys",
				"runtime.commands",
				"runtime.hosted_ports",
				"runtime.sandbox_desktops",
				"runtime.desktop_tickets",
				"runtime.agent_events",
				"runtime.agent_synthetic_events",
				"runtime.node_clone_slots",
				"runtime.reconcile_seen",
				"runtime.port_auth_codes",
				"runtime.environments",
				"tunnel.gateway_instances",
				"tunnel.tunnel_sessions",
				"tunnel.tunnel_credentials",
			].sort(),
		);
	});
});

describe.skipIf(skipPg())("drizzle schema vs live database", () => {
	let db: TestDatabase;
	let live: Map<string, Map<string, Col>>;

	beforeAll(async () => {
		db = await createTestDatabase();
		const res = await db.pool.query<{
			table_schema: string;
			table_name: string;
			column_name: string;
			udt_name: string;
			is_nullable: "YES" | "NO";
		}>(
			`SELECT c.table_schema, c.table_name, c.column_name, c.udt_name, c.is_nullable
			   FROM information_schema.columns c
			   JOIN information_schema.tables t
			     ON t.table_schema = c.table_schema AND t.table_name = c.table_name
			  WHERE c.table_schema IN ('runtime', 'tunnel') AND t.table_type = 'BASE TABLE'`,
		);
		live = new Map();
		for (const r of res.rows) {
			const key = `${r.table_schema}.${r.table_name}`;
			let cols = live.get(key);
			if (!cols) {
				cols = new Map();
				live.set(key, cols);
			}
			cols.set(r.column_name, {
				udt: r.udt_name,
				nullable: r.is_nullable === "YES",
			});
		}
	});

	afterAll(async () => {
		await db?.drop();
	});

	it("has the same set of tables", () => {
		const drizzleTables = tables.map((t) => `${t.schema}.${t.name}`).sort();
		expect([...live.keys()].sort()).toEqual(drizzleTables);
	});

	for (const t of tables) {
		const key = `${t.schema}.${t.name}`;
		it(`${key}: columns, types and nullability match`, () => {
			const want = new Map<string, Col>(
				t.columns.map((c) => [
					c.name,
					{ udt: udtOf(c.getSQLType()), nullable: !c.notNull },
				]),
			);
			const got = live.get(key);
			expect(got, `table ${key} missing in the database`).toBeDefined();
			const sorted = (m: Map<string, Col>) =>
				Object.fromEntries(
					[...m.entries()].sort(([a], [b]) => a.localeCompare(b)),
				);
			expect(sorted(got ?? new Map())).toEqual(sorted(want));
		});
	}
});
