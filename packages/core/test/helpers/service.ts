// Test fixtures for SandboxService: an isolated template per test (unique slug,
// own node), a StaticConfigReader for it, a principal of a fresh team and a
// service wired to RecordingJobSender.
import { randomBytes, randomUUID } from "node:crypto";
import { StaticConfigReader } from "@umiak/config";
import type pg from "pg";
import { expect } from "vitest";
import {
	emptySecretSets,
	KeyRing,
	type Notifier,
	type Principal,
	RecordingJobSender,
	SandboxServiceImpl,
	SCOPES,
	type SecretSets,
	UmiakError,
} from "../../src/index.ts";
import {
	createTopology,
	insertMachine,
	type Queryable,
	type Topology,
	type TopologyOptions,
} from "./topology.ts";

let seq = 0;

export const SIZES = [
	{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
	{ slug: "4gb", vcpu: 2, memoryMb: 4096 },
	{ slug: "8gb", vcpu: 4, memoryMb: 8192 },
];

export function testKeys(): KeyRing {
	return KeyRing.fromObject({
		current: 1,
		keys: { "1": randomBytes(32).toString("base64") },
	});
}

export function principal(over: Partial<Principal> = {}): Principal {
	return {
		kind: "team_key",
		userId: null,
		teamId: randomUUID(),
		role: null,
		isOperator: false,
		apiKeyId: randomUUID(),
		scopes: [...SCOPES],
		...over,
	};
}

export interface EnvOptions {
	templateSlug?: string;
	capabilities?: string[];
	os?: "linux" | "windows";
	enabled?: boolean;
	allowedSizes?: string[];
	topology?: TopologyOptions;
	quota?: {
		maxActiveSandboxes?: number;
		maxRamMb?: number;
		maxSavedSnapshots?: number;
	};
	defaults?: Record<string, unknown>;
	notifier?: Notifier;
	/** The fallback poll of the waits (default 2 s with a notifier). */
	waitPollMs?: number;
	slugRandom?: (n: number) => number;
}

export interface ServiceEnv {
	template: string;
	pairKey: string;
	topo: Topology;
	p: Principal;
	jobs: RecordingJobSender;
	keys: KeyRing;
	config: StaticConfigReader;
	svc: SandboxServiceImpl;
}

export async function serviceEnv(
	pool: pg.Pool,
	opts: EnvOptions = {},
): Promise<ServiceEnv> {
	seq += 1;
	const template = opts.templateSlug ?? `tpl${process.pid}x${seq}`;
	const topo = await createTopology(pool, {
		...opts.topology,
		build: {
			...opts.topology?.build,
			templateSlug: template,
			os: opts.os ?? "linux",
		},
	});
	const p = principal();
	const config = StaticConfigReader.fromObject({
		templates: [
			{
				slug: template,
				os: opts.os ?? "linux",
				enabled: opts.enabled ?? true,
				...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
				defaultSize: "2gb",
				allowedSizes: opts.allowedSizes ?? ["2gb", "4gb"],
			},
		],
		sizes: SIZES,
		quotas: {
			default: {
				maxActiveSandboxes: 100,
				maxRamMb: 1_000_000,
				maxSavedSnapshots: 10,
			},
			teams: opts.quota ? { [p.teamId]: opts.quota } : {},
		},
		defaults: { defaultTemplate: template, ...opts.defaults },
	});
	const jobs = new RecordingJobSender();
	const keys = testKeys();
	const svc = new SandboxServiceImpl({
		pool,
		config,
		keys,
		jobs,
		...(opts.notifier ? { notifier: opts.notifier } : {}),
		...(opts.waitPollMs ? { waitPollMs: opts.waitPollMs } : {}),
		...(opts.slugRandom ? { slugRandom: opts.slugRandom } : {}),
	});
	return {
		template,
		pairKey: `${template}/2gb`,
		topo,
		p,
		jobs,
		keys,
		config,
		svc,
	};
}

/**
 * Sandbox-side rows a create may write, counted for one team (for "nothing
 * was created"). Machines are checked per node with `nodeMachines`.
 */
export async function teamRowCounts(
	q: Queryable,
	teamId: string,
): Promise<Record<string, number>> {
	const r = await q.query<Record<string, number>>(
		`WITH s AS (SELECT id FROM runtime.sandboxes WHERE team_id = $1)
		 SELECT
		   (SELECT count(*)::int FROM s) AS sandboxes,
		   (SELECT count(*)::int FROM runtime.sandbox_secrets WHERE sandbox_id IN (SELECT id FROM s)) AS secrets,
		   (SELECT count(*)::int FROM runtime.operations WHERE sandbox_id IN (SELECT id FROM s)) AS operations,
		   (SELECT count(*)::int FROM runtime.sandbox_events WHERE sandbox_id IN (SELECT id FROM s)) AS events`,
		[teamId],
	);
	return r.rows[0] ?? {};
}

export interface MachineSnapshot {
	id: string;
	state: string;
	pool_key: string | null;
	sandbox_id: string | null;
}

/** Every machine of a node with the fields a create may change, by id. */
export async function nodeMachines(
	q: Queryable,
	nodeId: string,
): Promise<MachineSnapshot[]> {
	const r = await q.query<MachineSnapshot>(
		`SELECT id, state, pool_key, sandbox_id FROM runtime.machines
		 WHERE node_id = $1 ORDER BY id`,
		[nodeId],
	);
	return r.rows;
}

export async function idempotencyRows(
	q: Queryable,
	principalId: string,
): Promise<number> {
	const r = await q.query<{ n: number }>(
		"SELECT count(*)::int AS n FROM runtime.idempotency_keys WHERE principal_id = $1",
		[principalId],
	);
	return r.rows[0]?.n ?? 0;
}

export async function machineRow(
	q: Queryable,
	id: string,
): Promise<Record<string, unknown> | undefined> {
	const r = await q.query("SELECT * FROM runtime.machines WHERE id = $1", [id]);
	return r.rows[0];
}

/** Inserts a saved snapshot of the topology's build for a team. */
export async function insertSavedSnapshot(
	q: Queryable,
	topo: Topology,
	opts: { teamId: string; name: string; state?: string },
): Promise<string> {
	const id = randomUUID();
	await q.query(
		`INSERT INTO runtime.snapshots
		   (id, kind, team_id, name, provider_id, node_id, storage_id, template_build_id, lv_id, state)
		 VALUES ($1, 'saved', $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			id,
			opts.teamId,
			opts.name,
			topo.providerId,
			topo.nodeId,
			topo.storageId,
			topo.templateBuildId,
			id.replaceAll("-", ""),
			opts.state ?? "ready",
		],
	);
	return id;
}

/** Awaits a rejection with UmiakError `code` and returns the error. */
export async function expectCode(
	promise: Promise<unknown>,
	code: string,
): Promise<UmiakError> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(UmiakError);
	expect((err as UmiakError).code).toBe(code);
	return err as UmiakError;
}

export interface SeedOptions {
	state: string;
	/** null: the sandbox has no machine. Default `running`. */
	machineState?: string | null;
	memoryMb?: number;
	slug?: string;
	labels?: Record<string, string>;
	ttlSeconds?: number | null;
	lastRecoverAgoSeconds?: number;
	sets?: SecretSets;
	/** Team of the sandbox; default `env.p.teamId`. */
	teamId?: string;
	powerObserved?: "running" | "stopped" | "paused" | "unknown";
}

export interface Seeded {
	sandboxId: string;
	machineId: string | null;
	slug: string;
}

let seedSeq = 0;
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** A slug that is unique across test files and matches the S4 grammar. */
export function uniqueSlug(prefix = "box"): string {
	seedSeq += 1;
	let n = process.pid * 1000 + seedSeq;
	let tail = "";
	do {
		tail += LETTERS[n % 26];
		n = Math.floor(n / 26);
	} while (n > 0);
	const rnd = randomBytes(2);
	return `${prefix}-${tail}${LETTERS[(rnd[0] ?? 0) % 26]}${LETTERS[(rnd[1] ?? 0) % 26]}`;
}

/**
 * Inserts a sandbox of the env's template on its node with its current
 * machine and an encrypted secrets row (as create would leave them).
 */
export async function seedSandbox(
	q: Queryable,
	env: ServiceEnv,
	opts: SeedOptions,
): Promise<Seeded> {
	const sandboxId = randomUUID();
	const memoryMb = opts.memoryMb ?? 2048;
	const slug = opts.slug ?? uniqueSlug();
	const machineState =
		opts.machineState === undefined ? "running" : opts.machineState;
	let machineId: string | null = null;
	if (machineState !== null) {
		machineId = await insertMachine(q, env.topo, {
			state: machineState,
			memoryMb,
			sizeSlug: memoryMb === 4096 ? "4gb" : "2gb",
			sandboxId,
			powerObserved:
				opts.powerObserved ??
				(machineState === "stopped" ? "stopped" : "running"),
		});
	}
	await q.query(
		`INSERT INTO runtime.sandboxes
		   (id, slug, team_id, labels, template_slug, size_slug, vcpu, memory_mb, template_build_id, origin,
		    provider_id, node_id, machine_id, state, ttl_seconds, last_recover_at)
		 VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8, 'template', $9, $10, $11, $12, $13,
		         CASE WHEN $14::int IS NULL THEN NULL ELSE now() - make_interval(secs => $14::int) END)`,
		[
			sandboxId,
			slug,
			opts.teamId ?? env.p.teamId,
			JSON.stringify(opts.labels ?? {}),
			env.template,
			memoryMb === 4096 ? "4gb" : "2gb",
			memoryMb,
			env.topo.templateBuildId,
			env.topo.providerId,
			env.topo.nodeId,
			machineId,
			opts.state,
			opts.ttlSeconds ?? null,
			opts.lastRecoverAgoSeconds ?? null,
		],
	);
	const blob = env.keys.encrypt(sandboxId, opts.sets ?? emptySecretSets());
	await q.query(
		`INSERT INTO runtime.sandbox_secrets (sandbox_id, key_version, nonce, ciphertext)
		 VALUES ($1, $2, $3, $4)`,
		[sandboxId, blob.keyVersion, blob.nonce, blob.ciphertext],
	);
	return { sandboxId, machineId, slug };
}

/** Decrypts the secrets row of a sandbox with its own AAD. */
export async function readSecrets(
	q: Queryable,
	keys: KeyRing,
	sandboxId: string,
): Promise<SecretSets> {
	const r = await q.query(
		"SELECT key_version, nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
		[sandboxId],
	);
	const row = r.rows[0];
	if (!row) throw new Error(`no secrets row for ${sandboxId}`);
	return keys.decrypt(sandboxId, {
		keyVersion: row.key_version,
		nonce: row.nonce,
		ciphertext: row.ciphertext,
	});
}

/** Raw secrets row (to compare ciphertext before and after). */
export async function secretsRow(
	q: Queryable,
	sandboxId: string,
): Promise<{ nonce: Buffer; ciphertext: Buffer } | undefined> {
	const r = await q.query(
		"SELECT nonce, ciphertext FROM runtime.sandbox_secrets WHERE sandbox_id = $1",
		[sandboxId],
	);
	return r.rows[0];
}

export async function sandboxRow(
	q: Queryable,
	id: string,
): Promise<Record<string, unknown> | undefined> {
	const r = await q.query("SELECT * FROM runtime.sandboxes WHERE id = $1", [
		id,
	]);
	return r.rows[0];
}
