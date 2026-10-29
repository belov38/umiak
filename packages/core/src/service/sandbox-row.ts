import type { Tx } from "@sbx/db";
import { slugTaken } from "../errors.ts";
import type { SandboxOrigin } from "../rows.ts";
import { generateSlug, slugProblem } from "../slug.ts";
import type { SandboxServiceDeps } from "./common.ts";

// Insert of a new `creating` sandbox row (create and fork target) with the
// requested slug or a generated one.

// Generated slugs (S7 §5.4): the first try plus 5 retries with three words,
// then four-word tries.
export const SLUG_THREE_WORD_TRIES = 6;
export const SLUG_FOUR_WORD_TRIES = 6;

export interface NewSandboxRow {
	id: string;
	teamId: string;
	createdBy: string | null;
	createdByKey: string | null;
	name: string | null;
	labels: Record<string, string>;
	templateSlug: string;
	sizeSlug: string;
	vcpu: number;
	memoryMb: number;
	templateBuildId: string;
	origin: SandboxOrigin;
	originSnapshotId: string | null;
	forkedFromSandboxId: string | null;
	providerId: string;
	nodeId: string;
	machineId: string;
	ttlSeconds: number | null;
	idleTimeoutSeconds: number | null;
}

/**
 * Inserts the sandbox row with the given slug (`slug_taken` if taken) or a
 * generated one (see SLUG_THREE_WORD_TRIES). Returns the slug.
 * `ON CONFLICT (slug) DO NOTHING` keeps the transaction usable on a collision.
 */
export async function insertSandboxRow(
	tx: Tx,
	deps: SandboxServiceDeps,
	requestedSlug: string | undefined,
	row: NewSandboxRow,
): Promise<string> {
	const values = [
		row.id,
		row.teamId,
		row.createdBy,
		row.createdByKey,
		row.name,
		JSON.stringify(row.labels),
		row.templateSlug,
		row.sizeSlug,
		row.vcpu,
		row.memoryMb,
		row.templateBuildId,
		row.origin,
		row.originSnapshotId,
		row.forkedFromSandboxId,
		row.providerId,
		row.nodeId,
		row.machineId,
		row.ttlSeconds,
		row.idleTimeoutSeconds,
	];
	const tryInsert = async (slug: string): Promise<boolean> => {
		const r = await tx.client.query(
			`INSERT INTO runtime.sandboxes
			   (slug, id, team_id, created_by, created_by_key, name, labels, template_slug, size_slug,
			    vcpu, memory_mb, template_build_id, origin, origin_snapshot_id, forked_from_sandbox_id,
			    provider_id, node_id, machine_id, state, ttl_seconds, idle_timeout_seconds)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
			         'creating', $19, $20)
			 ON CONFLICT (slug) DO NOTHING
			 RETURNING slug`,
			[slug, ...values],
		);
		return r.rowCount === 1;
	};
	if (requestedSlug !== undefined) {
		if (await tryInsert(requestedSlug)) return requestedSlug;
		throw slugTaken(requestedSlug);
	}
	for (let i = 0; i < SLUG_THREE_WORD_TRIES + SLUG_FOUR_WORD_TRIES; i++) {
		const words = i < SLUG_THREE_WORD_TRIES ? 3 : 4;
		const slug = generateSlug(words, deps.slugRandom);
		if (slugProblem(slug) !== null) continue;
		if (await tryInsert(slug)) return slug;
	}
	throw new Error("could not generate a free slug");
}
