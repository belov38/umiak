// Sandbox (core) -> Sandbox resource (S7 §8.1). Ids through the codecs of
// @umiak/auth, ISO times with ms, `origin` as an object, endpoints from the
// settings, internal `reprovision` hidden as `activeOperation: null`.
// `environment` is always null and `excludeOwnerSecrets` false until the
// sandbox stores them (decision 7).
import { decodeUuid, encodeUuid } from "@umiak/auth";
import type { ConfigReader } from "@umiak/config";
import { canonicalTemplateSlug } from "@umiak/config";
import { isUuid, type Sandbox } from "@umiak/core";
import type pg from "pg";
import { notFoundError } from "../http/errors.ts";
import { isPublicOperation } from "../http/wait.ts";
import { type PreviewSettings, previewUrl } from "../preview-url.ts";
import type { SandboxResource } from "../schemas/sandbox.ts";
import type { Settings } from "../settings.ts";
import { iso, isoOrNull, toOperationResource } from "./operation.ts";

/** Columns the core Sandbox does not carry, read in one query per page. */
export interface SandboxExtras {
	/** Version of `template_builds`; null if the build is gone. */
	templateVersion: string | null;
	/** S9 build on VM 598 remains headless after the catalog consolidation. */
	legacyHeadlessWindows?: boolean;
	/** Name of the origin snapshot while it is ready; null once deleted or replaced. */
	snapshotName: string | null;
	updatedAt: Date | null;
}

export interface SandboxMapContext {
	settings: Pick<Settings, "sshHost" | "sshPort"> & PreviewSettings;
	extras: SandboxExtras | undefined;
}

/**
 * Path reference -> core reference: `sb_...` is always an id (a bad one is
 * 404), anything else a slug. A bare UUID is never a slug (core would read
 * it as an id), so it is 404 too.
 */
export function resolveSandboxRef(ref: string): string {
	if (ref.slice(0, 3).toLowerCase() === "sb_") {
		const id = decodeUuid("sandbox", ref);
		if (id === null) throw notFoundError("sandbox");
		return id;
	}
	if (isUuid(ref)) throw notFoundError("sandbox");
	return ref;
}

export function sandboxEndpoints(
	slug: string,
	s: SandboxMapContext["settings"],
): SandboxResource["endpoints"] {
	const port = s.sshPort === 22 ? "" : ` -p ${s.sshPort}`;
	return {
		portUrlTemplate: previewUrl(`${slug}-{port}`, s),
		ssh: `ssh${port} ${slug}@${s.sshHost}`,
	};
}

function origin(s: Sandbox, x: SandboxExtras | undefined) {
	if (s.origin === "snapshot" && s.originSnapshotId !== null) {
		return {
			kind: "snapshot" as const,
			snapshot: x?.snapshotName ?? null,
			snapshotId: encodeUuid("snapshot", s.originSnapshotId),
		};
	}
	if (s.origin === "fork" && s.forkedFromSandboxId !== null) {
		return {
			kind: "fork" as const,
			sandboxId: encodeUuid("sandbox", s.forkedFromSandboxId),
		};
	}
	return { kind: s.origin };
}

export function toSandboxResource(
	s: Sandbox,
	ctx: SandboxMapContext,
): SandboxResource {
	const x = ctx.extras;
	const op = s.activeOperation;
	return {
		id: encodeUuid("sandbox", s.id),
		slug: s.slug,
		name: s.name,
		teamId: encodeUuid("team", s.teamId),
		createdBy: s.createdBy === null ? null : encodeUuid("user", s.createdBy),
		createdByKey:
			s.createdByKey === null ? null : encodeUuid("apiKey", s.createdByKey),
		template: canonicalTemplateSlug(s.templateSlug),
		templateVersion: x?.templateVersion ?? null,
		size: s.sizeSlug,
		vcpu: s.vcpu,
		memoryMb: s.memoryMb,
		state: s.state,
		health: s.health,
		healthReason: s.healthReason,
		degradedSince: isoOrNull(s.degradedSince),
		activity: s.activity,
		lastActivityAt: isoOrNull(s.lastActivityAt),
		stopReason: s.stopReason,
		error:
			s.errorCode === null
				? null
				: { code: s.errorCode, message: s.errorMessage ?? s.errorCode },
		origin: origin(s, x),
		labels: s.labels,
		ttlSeconds: s.ttlSeconds,
		deadlineAt: isoOrNull(s.deadlineAt),
		idleTimeoutSeconds: s.idleTimeoutSeconds,
		activeOperation:
			op !== null && isPublicOperation(op) ? toOperationResource(op) : null,
		endpoints: sandboxEndpoints(s.slug, ctx.settings),
		environment: null,
		excludeOwnerSecrets: false,
		blocked: s.blocked,
		blockReason: s.blocked ? s.blockReason : null,
		createdAt: iso(s.createdAt),
		readyAt: isoOrNull(s.readyAt),
		stoppedAt: isoOrNull(s.stoppedAt),
		deletedAt: isoOrNull(s.deletedAt),
		updatedAt: iso(x?.updatedAt ?? s.stateChangedAt),
	};
}

/** Extras of the sandboxes by id, in one query; empty without a database. */
export async function loadSandboxExtras(
	pool: pg.Pool | null,
	list: readonly Sandbox[],
): Promise<Map<string, SandboxExtras>> {
	const out = new Map<string, SandboxExtras>();
	if (pool === null || list.length === 0) return out;
	const r = await pool.query<{
		id: string;
		version: string | null;
		legacy_headless_windows: boolean;
		snapshot_name: string | null;
		updated_at: Date | null;
	}>(
		`SELECT s.id, b.version, s.updated_at,
                (b.os = 'windows' AND b.pve_vmid = 598) AS legacy_headless_windows,
		        CASE WHEN sn.state = 'ready' THEN sn.name END AS snapshot_name
		 FROM runtime.sandboxes s
		 LEFT JOIN runtime.template_builds b ON b.id = s.template_build_id
		 LEFT JOIN runtime.snapshots sn ON sn.id = s.origin_snapshot_id
		 WHERE s.id = ANY($1::uuid[])`,
		[list.map((s) => s.id)],
	);
	for (const row of r.rows) {
		out.set(row.id, {
			templateVersion: row.version,
			legacyHeadlessWindows: row.legacy_headless_windows,
			snapshotName: row.snapshot_name,
			updatedAt: row.updated_at,
		});
	}
	return out;
}

/** Resources of sandboxes with their extras (one query). */
export async function sandboxResources(
	deps: {
		pool: pg.Pool | null;
		settings: SandboxMapContext["settings"];
		config?: ConfigReader;
	},
	list: readonly Sandbox[],
): Promise<SandboxResource[]> {
	const extras = await loadSandboxExtras(deps.pool, list);
	return Promise.all(
		list.map(async (s) => {
			const resource = toSandboxResource(s, {
				settings: deps.settings,
				extras: extras.get(s.id),
			});
			if (
				!extras.get(s.id)?.legacyHeadlessWindows &&
				(await deps.config?.template(s.templateSlug))?.capabilities.includes(
					"desktop",
				)
			)
				resource.endpoints.desktop = `${previewUrl(`${s.slug}-desktop`, deps.settings)}/`;
			return resource;
		}),
	);
}

export async function sandboxResource(
	deps: {
		pool: pg.Pool | null;
		settings: SandboxMapContext["settings"];
		config?: ConfigReader;
	},
	s: Sandbox,
): Promise<SandboxResource> {
	const [r] = await sandboxResources(deps, [s]);
	if (r === undefined) throw new Error("sandboxResource: no resource");
	return r;
}
