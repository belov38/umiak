import { withTx } from "@umiak/db";
import { invalidState, slugTaken } from "../errors.ts";
import type { Principal } from "../principal.ts";
import type { Sandbox } from "../rows.ts";
import { validateSlug } from "../slug.ts";
import {
	findSandboxRow,
	type SandboxRow,
	type SandboxServiceDeps,
	toSandbox,
} from "./common.ts";

// Slug change (S7 §5.4, §20.2 item 4). In one transaction under the sandbox row
// lock: the new slug, the new labels `<slug>-<port>` of all live hosted ports
// and their `auth_epoch + 1`, so old URLs and cookies stop working at once
// (S4 §8.2). The triggers notify `umiak_routes` with the old and the new slug.
//
// Epochs never repeat per label: a cookie is bound to {label, mode,
// authEpoch}, and `hostPort` continues a label above every row it has. The
// relabeled row leaves that history, so a revoked copy of it stays under the
// old label (`deleted_at` set, epoch + 1), and the relabeled row continues
// above every row of its new label.

/** `unique_violation` of the slug index. */
function isSlugConflict(e: unknown): boolean {
	const err = e as { code?: unknown; constraint?: unknown } | null;
	return (
		err?.code === "23505" &&
		typeof err.constraint === "string" &&
		err.constraint.includes("slug")
	);
}

export async function renameSandbox(
	deps: SandboxServiceDeps,
	p: Principal,
	idOrSlug: string,
	slug: string,
): Promise<Sandbox> {
	validateSlug(slug);
	try {
		return await withTx(deps.pool, async (tx) => {
			const row = await findSandboxRow(tx.client, p, idOrSlug, {
				lock: true,
				write: true,
			});
			if (row.state === "deleting" || row.state === "deleted") {
				throw invalidState(row.state);
			}
			if (row.slug === slug) return toSandbox(tx.client, row);
			const taken = await tx.client.query(
				"SELECT 1 FROM runtime.sandboxes WHERE slug = $1",
				[slug],
			);
			if ((taken.rowCount ?? 0) > 0) throw slugTaken(slug);

			const r = await tx.client.query<SandboxRow>(
				`UPDATE runtime.sandboxes SET slug = $2, version = version + 1
				 WHERE id = $1 RETURNING *`,
				[row.id, slug],
			);
			const updated = r.rows[0];
			if (!updated) throw new Error("rename: sandbox row vanished under lock");

			// History of the old labels (see above).
			await tx.client.query(
				`INSERT INTO runtime.hosted_ports
				   (sandbox_id, port, label, mode, token_hash, host_rewrite, app_protocol,
				    auth_epoch, created_at, deleted_at)
				 SELECT sandbox_id, port, label, mode, NULL, host_rewrite, app_protocol,
				        auth_epoch + 1, created_at, now()
				 FROM runtime.hosted_ports
				 WHERE sandbox_id = $1 AND deleted_at IS NULL`,
				[row.id],
			);
			await tx.client.query(
				`UPDATE runtime.hosted_ports hp
				 SET label = $2 || '-' || hp.port,
				     auth_epoch = GREATEST(hp.auth_epoch + 1, COALESCE(
				       (SELECT max(o.auth_epoch) + 1 FROM runtime.hosted_ports o
				        WHERE o.label = $2 || '-' || hp.port), 0))
				 WHERE hp.sandbox_id = $1 AND hp.deleted_at IS NULL`,
				[row.id, slug],
			);
			return toSandbox(tx.client, updated);
		});
	} catch (e) {
		// A concurrent rename or create took the slug after the check above.
		if (isSlugConflict(e)) throw slugTaken(slug);
		throw e;
	}
}
