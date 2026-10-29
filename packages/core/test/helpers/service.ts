// Test fixtures for SandboxService: an isolated template per test (unique slug,
// own node), a StaticConfigReader for it, a principal of a fresh team and a
// service wired to RecordingJobSender.
import { randomBytes, randomUUID } from "node:crypto";
import { StaticConfigReader } from "@sbx/config";
import type pg from "pg";
import { expect } from "vitest";
import {
	KeyRing,
	type Notifier,
	type Principal,
	RecordingJobSender,
	SandboxServiceImpl,
	SbxError,
	SCOPES,
} from "../../src/index.ts";
import {
	createTopology,
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
	const template = `tpl${process.pid}x${seq}`;
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

/** Rows a create may write, counted for one team (for "nothing was created"). */
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
		   (SELECT count(*)::int FROM runtime.sandbox_events WHERE sandbox_id IN (SELECT id FROM s)) AS events,
		   (SELECT count(*)::int FROM runtime.machines WHERE sandbox_id IN (SELECT id FROM s)) AS machines`,
		[teamId],
	);
	return r.rows[0] ?? {};
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

/** Awaits a rejection with SbxError `code` and returns the error. */
export async function expectCode(
	promise: Promise<unknown>,
	code: string,
): Promise<SbxError> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(err).toBeInstanceOf(SbxError);
	expect((err as SbxError).code).toBe(code);
	return err as SbxError;
}
