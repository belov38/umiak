// SavedSnapshot (core) -> Snapshot resource (S7 §13). The template, its
// version, the size and the error of a failed save are not on the core row;
// they are read for a whole list in one query.
import { encodeUuid } from "@umiak/auth";
import { canonicalTemplateSlug } from "@umiak/config";
import type { SavedSnapshot } from "@umiak/core";
import type pg from "pg";
import type { SnapshotResource } from "../schemas/snapshot.ts";
import { iso, isoOrNull } from "./operation.ts";

interface SnapshotExtras {
	template: string | null;
	templateVersion: string | null;
	size: string | null;
	error: { code: string; message: string } | null;
}

async function loadExtras(
	pool: pg.Pool | null,
	list: readonly SavedSnapshot[],
): Promise<Map<string, SnapshotExtras>> {
	const out = new Map<string, SnapshotExtras>();
	if (pool === null || list.length === 0) return out;
	const r = await pool.query<{
		id: string;
		template_slug: string | null;
		version: string | null;
		size_slug: string | null;
		error_code: string | null;
		error_message: string | null;
	}>(
		// The size of the machine the snapshot was taken from, else of the
		// sandbox; the error of the failed save_snapshot operation that made it.
		`SELECT sn.id, b.template_slug, b.version,
		        COALESCE(m.size_slug, s.size_slug) AS size_slug,
		        op.error_code, op.error_message
		 FROM runtime.snapshots sn
		 LEFT JOIN runtime.template_builds b ON b.id = sn.template_build_id
		 LEFT JOIN runtime.machines m ON m.id = sn.source_machine_id
		 LEFT JOIN runtime.sandboxes s ON s.id = sn.source_sandbox_id
		 LEFT JOIN LATERAL (
		   SELECT o.error_code, o.error_message FROM runtime.operations o
		   WHERE o.sandbox_id = sn.source_sandbox_id AND o.kind = 'save_snapshot'
		     AND o.request->>'snapshotId' = sn.id::text AND o.state = 'failed'
		   LIMIT 1
		 ) op ON sn.state = 'failed'
		 WHERE sn.id = ANY($1::uuid[])`,
		[list.map((s) => s.id)],
	);
	for (const row of r.rows) {
		out.set(row.id, {
			template: row.template_slug,
			templateVersion: row.version,
			size: row.size_slug,
			error:
				row.error_code === null
					? null
					: {
							code: row.error_code,
							message: row.error_message ?? row.error_code,
						},
		});
	}
	return out;
}

function failedWithoutCause(s: SavedSnapshot) {
	return s.state === "failed"
		? { code: "snapshot_failed", message: "the snapshot could not be taken" }
		: null;
}

export function toSnapshotResource(
	s: SavedSnapshot,
	x: SnapshotExtras | undefined,
): SnapshotResource {
	return {
		id: encodeUuid("snapshot", s.id),
		name: s.name ?? s.pendingName ?? "",
		state: s.state as SnapshotResource["state"],
		sourceSandboxId:
			s.sourceSandboxId === null
				? null
				: encodeUuid("sandbox", s.sourceSandboxId),
		template: x?.template ? canonicalTemplateSlug(x.template) : null,
		templateVersion: x?.templateVersion ?? null,
		size: x?.size ?? null,
		consistency: s.consistency,
		error: x?.error ?? failedWithoutCause(s),
		createdAt: iso(s.createdAt),
		readyAt: isoOrNull(s.readyAt),
	};
}

export async function snapshotResources(
	pool: pg.Pool | null,
	list: readonly SavedSnapshot[],
): Promise<SnapshotResource[]> {
	const extras = await loadExtras(pool, list);
	return list.map((s) => toSnapshotResource(s, extras.get(s.id)));
}

export async function snapshotResource(
	pool: pg.Pool | null,
	s: SavedSnapshot,
): Promise<SnapshotResource> {
	return (await snapshotResources(pool, [s]))[0] as SnapshotResource;
}
