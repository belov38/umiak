import { randomUUID } from "node:crypto";
import { StaticConfigReader } from "@umiak/config";
import { DELETE_RETRY_LIMIT, RecordingJobSender } from "@umiak/core";
import { createTestDatabase, type TestDatabase } from "@umiak/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AdminDeps, runAdmin } from "../src/admin/commands.ts";
import { FakeInfraRegistry } from "./fakes/infra.ts";
import { testLogger } from "./helpers/worker.ts";

let db: TestDatabase;
let jobs: RecordingJobSender;
let out: Record<string, unknown>[];
let err: Record<string, unknown>[];
let configYaml: string;

beforeAll(async () => {
	db = await createTestDatabase();
});
afterAll(async () => {
	await db?.drop();
});

function topologyYaml(o: { ramCapMb?: number; version?: string } = {}) {
	return `
templates:
  - slug: linux
    os: linux
    defaultSize: 2gb
    allowedSizes: [2gb]
sizes:
  - slug: 2gb
    vcpu: 2
    memoryMb: 2048
topology:
  providers:
    - name: pve-lab
      clusterMacId: 7
      vmidMin: 500
      vmidMax: 598
      apiUrl: https://100.64.0.1:8006
      tlsName: pve
      secretRef: pve
      nodes:
        - name: pve
          ramCapMb: ${o.ramCapMb ?? 24576}
          cloneConcurrency: 3
          nodeAgentRef: umiak-node
          storages:
            - name: local-lvm
  templateBuilds:
    - templateSlug: linux
      version: ${o.version ?? "seed-599"}
      os: linux
      node: pve
      storage: local-lvm
      pveVmid: 599
      bootTimeoutS: 300
      diskLayout: {scsi0: {size: 8G}}
`;
}

function deps(): AdminDeps {
	return {
		pool: db.pool,
		out: (o) => out.push(o),
		err: (o) => err.push(o),
		config: () => StaticConfigReader.fromYaml(configYaml, "test.yaml"),
		jobs: async () => jobs,
		infra: () => new FakeInfraRegistry(),
		log: testLogger("warn").log,
	};
}

async function admin(...argv: string[]): Promise<number> {
	return runAdmin(argv, deps());
}

async function counts(): Promise<Record<string, number>> {
	const r = await db.pool.query<Record<string, number>>(
		`SELECT (SELECT count(*)::int FROM runtime.providers) AS providers,
		        (SELECT count(*)::int FROM runtime.nodes) AS nodes,
		        (SELECT count(*)::int FROM runtime.storages) AS storages,
		        (SELECT count(*)::int FROM runtime.template_builds) AS builds,
		        (SELECT count(*)::int FROM runtime.node_clone_slots) AS slots`,
	);
	return r.rows[0] ?? {};
}

async function node(): Promise<Record<string, unknown>> {
	const r = await db.pool.query(
		"SELECT * FROM runtime.nodes WHERE name = 'pve'",
	);
	return r.rows[0];
}

async function builds(): Promise<Record<string, unknown>[]> {
	const r = await db.pool.query(
		`SELECT id, version, status, promoted_at FROM runtime.template_builds
		 WHERE template_slug = 'linux' ORDER BY created_at, version`,
	);
	return r.rows;
}

beforeEach(() => {
	jobs = new RecordingJobSender();
	out = [];
	err = [];
	configYaml = topologyYaml();
});

describe("umiak-admin bootstrap", () => {
	it("is idempotent: a second run creates no duplicates", async () => {
		expect(await admin("bootstrap")).toBe(0);
		const first = await counts();
		expect(first).toEqual({
			providers: 1,
			nodes: 1,
			storages: 1,
			builds: 1,
			slots: 3,
		});
		const b = await builds();
		expect(b).toHaveLength(1);
		expect(b[0]).toMatchObject({ version: "seed-599", status: "active" });
		expect(b[0]?.promoted_at).toBeInstanceOf(Date);
		expect(out.map((o) => o.kind)).toEqual([
			"provider",
			"node",
			"storage",
			"template_build",
		]);

		out = [];
		expect(await admin("bootstrap")).toBe(0);
		expect(await counts()).toEqual(first);
		expect(out.find((o) => o.kind === "template_build")).toMatchObject({
			created: false,
			status: "active",
		});
	});

	it("updates changed topology values in place", async () => {
		configYaml = topologyYaml({ ramCapMb: 32768 });
		expect(await admin("bootstrap")).toBe(0);
		expect((await node()).ram_cap_mb).toBe(32768);
		expect((await counts()).nodes).toBe(1);
	});

	it("UMIAK_PVE_URL / UMIAK_PVE_TLS_NAME override apiUrl and tlsName of the first provider", async () => {
		const d = deps();
		d.providerOverride = { apiUrl: "https://10.9.8.7:8006", tlsName: "pve-x" };
		expect(await runAdmin(["bootstrap"], d)).toBe(0);
		const r = await db.pool.query(
			"SELECT api_url, tls_name FROM runtime.providers WHERE name = 'pve-lab'",
		);
		expect(r.rows).toEqual([
			{ api_url: "https://10.9.8.7:8006", tls_name: "pve-x" },
		]);
		// Without the override the YAML values come back.
		expect(await admin("bootstrap")).toBe(0);
		const back = await db.pool.query(
			"SELECT api_url, tls_name FROM runtime.providers WHERE name = 'pve-lab'",
		);
		expect(back.rows).toEqual([
			{ api_url: "https://100.64.0.1:8006", tls_name: "pve" },
		]);
	});

	it("needs UMIAK_CONFIG_FILE", async () => {
		const d = deps();
		delete d.config;
		expect(await runAdmin(["bootstrap"], d)).toBe(1);
		expect(String(err[0]?.error)).toMatch(/UMIAK_CONFIG_FILE/);
	});
});

describe("umiak-admin template", () => {
	it("register then promote: the old active build becomes deprecated", async () => {
		const n = await node();
		expect(
			await admin(
				"template",
				"register",
				"--template",
				"linux",
				"--version",
				"v2",
				"--os",
				"linux",
				"--node",
				String(n.id),
				"--storage",
				"local-lvm",
				"--pve-vmid",
				"597",
				"--boot-timeout-s",
				"300",
			),
		).toBe(0);
		const reg = out.at(-1);
		expect(reg).toMatchObject({
			kind: "template_build",
			version: "v2",
			status: "building",
		});
		const id = String(reg?.id);

		expect(await admin("template", "promote", id)).toBe(0);
		const b = await builds();
		expect(b.find((x) => x.version === "seed-599")?.status).toBe("deprecated");
		expect(b.find((x) => x.version === "v2")).toMatchObject({
			status: "active",
		});
		expect(b.find((x) => x.version === "v2")?.promoted_at).toBeInstanceOf(Date);
		expect(out.at(-1)).toMatchObject({
			kind: "template_build",
			id,
			status: "active",
			deprecated: [expect.any(String)],
		});

		// A bootstrap after the promote does not bring the seed build back.
		expect(await admin("bootstrap")).toBe(0);
		const after = await builds();
		expect(after.find((x) => x.version === "v2")?.status).toBe("active");
		expect(after.find((x) => x.version === "seed-599")?.status).toBe(
			"deprecated",
		);
	});

	it("promote of an unknown build fails with exit 1", async () => {
		expect(await admin("template", "promote", randomUUID())).toBe(1);
		expect(String(err[0]?.error)).toMatch(/not found/);
	});
});

describe("umiak-admin providers and nodes", () => {
	it("providers add and nodes add are upserts; cordon and uncordon", async () => {
		const provider = [
			"providers",
			"add",
			"--name",
			"pve-two",
			"--cluster-mac-id",
			"8",
			"--vmid-min",
			"1000",
			"--vmid-max",
			"1099",
			"--api-url",
			"https://10.0.0.2:8006",
			"--secret-ref",
			"pve2",
		];
		expect(await admin(...provider)).toBe(0);
		expect(out.at(-1)).toMatchObject({ kind: "provider", created: true });
		expect(await admin(...provider)).toBe(0);
		expect(out.at(-1)).toMatchObject({ kind: "provider", created: false });

		const nodeArgs = [
			"nodes",
			"add",
			"--provider",
			"pve-two",
			"--name",
			"n2",
			"--ram-cap-mb",
			"16384",
			"--node-agent-ref",
			"umiak-node",
			"--storage",
			"local-lvm",
		];
		expect(await admin(...nodeArgs)).toBe(0);
		expect(out.at(-1)).toMatchObject({
			kind: "node",
			name: "n2",
			created: true,
		});
		expect(await admin(...nodeArgs)).toBe(0);
		expect(out.at(-1)).toMatchObject({ kind: "node", created: false });
		const slots = await db.pool.query(
			`SELECT count(*)::int AS n FROM runtime.node_clone_slots s
			 JOIN runtime.nodes n ON n.id = s.node_id WHERE n.name = 'n2'`,
		);
		expect(slots.rows[0].n).toBe(4);

		expect(await admin("nodes", "cordon", "n2")).toBe(0);
		let st = await db.pool.query(
			"SELECT state FROM runtime.nodes WHERE name = 'n2'",
		);
		expect(st.rows[0].state).toBe("cordoned");
		expect(await admin("nodes", "uncordon", "n2")).toBe(0);
		st = await db.pool.query(
			"SELECT state FROM runtime.nodes WHERE name = 'n2'",
		);
		expect(st.rows[0].state).toBe("active");

		expect(await admin("nodes", "cordon", "no-such-node")).toBe(1);
	});
});

describe("umiak-admin pool status", () => {
	it("prints pool counts per pair and RAM per node", async () => {
		const n = await node();
		const b = await db.pool.query(
			`SELECT id, storage_id FROM runtime.template_builds
			 WHERE template_slug = 'linux' AND status = 'active'`,
		);
		const build = b.rows[0];
		for (const state of ["warm", "warm", "booting"]) {
			await db.pool.query(
				`INSERT INTO runtime.machines
				   (id, provider_id, node_id, storage_id, template_build_id, origin, pool_key,
				    size_slug, vcpu, memory_mb, state, power_observed)
				 VALUES ($1, $2, $3, $4, $5, 'template', 'linux/2gb', '2gb', 2, 2048, $6, 'running')`,
				[randomUUID(), n.provider_id, n.id, build.storage_id, build.id, state],
			);
		}
		expect(await admin("pool", "status")).toBe(0);
		expect(out).toContainEqual({
			kind: "pair",
			pair: "linux/2gb",
			states: { warm: 2, booting: 1 },
			warm: 2,
			booting: 1,
		});
		const nodeLine = out.find((o) => o.kind === "node" && o.node === "pve");
		expect(nodeLine).toEqual({
			kind: "node",
			node: "pve",
			nodeId: n.id,
			provider: "pve-lab",
			state: "active",
			capMb: n.ram_cap_mb,
			reservedMb: 3 * 2048,
			poweredMb: 3 * 2048,
		});
	});
});

describe("umiak-admin op retry and machine delete", () => {
	async function sandboxWithOp(state: string): Promise<{
		sandboxId: string;
		operationId: string;
		machineId: string;
	}> {
		const n = await node();
		const b = await db.pool.query(
			`SELECT id, storage_id FROM runtime.template_builds
			 WHERE template_slug = 'linux' AND status = 'active'`,
		);
		const build = b.rows[0];
		const sandboxId = randomUUID();
		const machineId = randomUUID();
		const operationId = randomUUID();
		await db.pool.query(
			`INSERT INTO runtime.machines
			   (id, provider_id, node_id, storage_id, template_build_id, origin,
			    size_slug, vcpu, memory_mb, state, sandbox_id)
			 VALUES ($1, $2, $3, $4, $5, 'template', '2gb', 2, 2048, 'running', $6)`,
			[machineId, n.provider_id, n.id, build.storage_id, build.id, sandboxId],
		);
		await db.pool.query(
			`INSERT INTO runtime.sandboxes
			   (id, slug, team_id, template_slug, size_slug, vcpu, memory_mb, template_build_id,
			    origin, provider_id, node_id, machine_id, state)
			 VALUES ($1, $2, $3, 'linux', '2gb', 2, 2048, $4, 'template', $5, $6, $7, 'ready')`,
			[
				sandboxId,
				`adm-${sandboxId.slice(0, 8)}`,
				randomUUID(),
				build.id,
				n.provider_id,
				n.id,
				machineId,
			],
		);
		await db.pool.query(
			`INSERT INTO runtime.operations (id, sandbox_id, kind, state)
			 VALUES ($1, $2, 'stop', $3)`,
			[operationId, sandboxId, state],
		);
		return { sandboxId, operationId, machineId };
	}

	it("op retry re-sends a non-terminal operation and refuses a terminal one", async () => {
		const live = await sandboxWithOp("running");
		expect(await admin("op", "retry", live.operationId)).toBe(0);
		expect(jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: live.operationId },
				opts: { singletonKey: live.sandboxId },
			},
		]);
		const done = await sandboxWithOp("succeeded");
		expect(await admin("op", "retry", done.operationId)).toBe(1);
		expect(String(err.at(-1)?.error)).toMatch(/terminal/);
		expect(jobs.sent).toHaveLength(1);
	});

	it("machine delete: a pool machine goes to deleting with a delete job; a sandbox's current machine needs --force", async () => {
		const n = await node();
		const b = await db.pool.query(
			`SELECT id, storage_id FROM runtime.template_builds
			 WHERE template_slug = 'linux' AND status = 'active'`,
		);
		const poolMachine = randomUUID();
		await db.pool.query(
			`INSERT INTO runtime.machines
			   (id, provider_id, node_id, storage_id, template_build_id, origin, pool_key,
			    size_slug, vcpu, memory_mb, state)
			 VALUES ($1, $2, $3, $4, $5, 'template', 'linux/2gb', '2gb', 2, 2048, 'warm')`,
			[poolMachine, n.provider_id, n.id, b.rows[0].storage_id, b.rows[0].id],
		);
		expect(await admin("machine", "delete", poolMachine)).toBe(0);
		const m = await db.pool.query(
			"SELECT state, error_code FROM runtime.machines WHERE id = $1",
			[poolMachine],
		);
		expect(m.rows[0]).toEqual({ state: "deleting", error_code: "operator" });
		expect(jobs.sent).toEqual([
			{
				queue: "machine-op",
				data: { machineId: poolMachine, action: "delete" },
				opts: { singletonKey: poolMachine, retryLimit: DELETE_RETRY_LIMIT },
			},
		]);

		const s = await sandboxWithOp("succeeded");
		expect(await admin("machine", "delete", s.machineId)).toBe(1);
		expect(String(err.at(-1)?.error)).toMatch(/--force/);
		expect(await admin("machine", "delete", s.machineId, "--force")).toBe(0);
		expect(jobs.sent).toHaveLength(2);
	});
});

describe("umiak-admin misc", () => {
	it("reconcile requires --dry-run and prints a summary", async () => {
		expect(await admin("reconcile")).toBe(1);
		expect(await admin("reconcile", "--dry-run")).toBe(0);
		expect(out.at(-1)).toMatchObject({ kind: "reconcile", dryRun: true });
	});

	it("migrate reports nothing to apply on a migrated database", async () => {
		expect(await admin("migrate")).toBe(0);
		expect(out.at(-1)).toEqual({ kind: "migrate", applied: [] });
	});

	it("migrate on an empty database creates the tunnel schema from S2's 0100", async () => {
		const empty = await createTestDatabase({ migrated: false });
		try {
			const lines: Record<string, unknown>[] = [];
			const run = (...args: string[]) =>
				runAdmin(["migrate", ...args], {
					pool: empty.pool,
					out: (o) => lines.push(o),
					err: (o) => lines.push(o),
					log: testLogger("warn").log,
				});
			// The temporary fixture flag is gone.
			expect(await run("--tunnel-fixture")).toBe(1);
			expect(await run()).toBe(0);
			const applied = lines.at(-1)?.applied as string[];
			expect(applied[0]).toMatch(/^0100_tunnel_init/);
			const t = await empty.pool.query(
				"SELECT to_regclass('tunnel.tunnel_sessions')::text AS n",
			);
			expect(t.rows[0].n).toBe("tunnel.tunnel_sessions");
		} finally {
			await empty.drop();
		}
	});

	it("unknown command: usage and exit 1", async () => {
		expect(await admin("frobnicate")).toBe(1);
		expect(String(err.at(-1)?.error)).toMatch(/usage/i);
		expect(await admin()).toBe(1);
	});
});
