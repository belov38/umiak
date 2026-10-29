import { parseLabel } from "./label.ts";
import type { PortMode } from "./rows.ts";
import { isUuid, type Queryable } from "./service/common.ts";
import type { SandboxState } from "./states.ts";

// Route and SSH lookups for the gateway (S6 §14.2, S4 §4.2, §6.1). No team
// check: callers are the internal handlers of `apps/api`. S7 maps the result
// to the S4 §6.1 response and adds its own fields (S7 §12.1).

export interface RouteTarget {
	sandboxId: string;
	slug: string;
	/** Null while the sandbox has no machine. */
	machineId: string | null;
	port: number;
	mode: PortMode;
	/** sha256 of the port token, hex; null unless `mode = token`. */
	tokenHash: string | null;
	authEpoch: number;
	/** The sandbox state as is; the gateway decides what to show. */
	state: SandboxState;
}

export interface SshTarget {
	sandboxId: string;
	machineId: string | null;
	state: SandboxState;
}

/**
 * The hosted port of `<slug>-<port>`, or null: label outside the grammar, no
 * such sandbox, port not hosted, sandbox deleted.
 */
export async function lookupRoute(
	q: Queryable,
	label: string,
): Promise<RouteTarget | null> {
	const parsed = typeof label === "string" ? parseLabel(label) : null;
	if (parsed === null) return null;
	const r = await q.query<{
		sandbox_id: string;
		slug: string;
		machine_id: string | null;
		port: number;
		mode: PortMode;
		token_hash: Buffer | null;
		auth_epoch: number;
		state: SandboxState;
	}>(
		`SELECT s.id AS sandbox_id, s.slug, s.machine_id, s.state,
		        hp.port, hp.mode, hp.token_hash, hp.auth_epoch
		 FROM runtime.sandboxes s
		 JOIN runtime.hosted_ports hp ON hp.sandbox_id = s.id AND hp.deleted_at IS NULL
		 WHERE s.slug = $1 AND hp.port = $2 AND s.state <> 'deleted'`,
		[parsed.slug, parsed.port],
	);
	const row = r.rows[0];
	if (!row) return null;
	return {
		sandboxId: row.sandbox_id,
		slug: row.slug,
		machineId: row.machine_id,
		port: row.port,
		mode: row.mode,
		tokenHash: row.token_hash === null ? null : row.token_hash.toString("hex"),
		authEpoch: row.auth_epoch,
		state: row.state,
	};
}

/** Sandbox of an SSH login by id or slug; null if unknown or deleted. */
export async function sshTarget(
	q: Queryable,
	sandboxIdOrSlug: string,
): Promise<SshTarget | null> {
	if (typeof sandboxIdOrSlug !== "string" || sandboxIdOrSlug === "") {
		return null;
	}
	const byId = isUuid(sandboxIdOrSlug);
	const r = await q.query<{
		id: string;
		machine_id: string | null;
		state: SandboxState;
	}>(
		`SELECT id, machine_id, state FROM runtime.sandboxes
		 WHERE ${byId ? "id" : "slug"} = $1 AND state <> 'deleted'`,
		[sandboxIdOrSlug],
	);
	const row = r.rows[0];
	if (!row) return null;
	return { sandboxId: row.id, machineId: row.machine_id, state: row.state };
}

export interface Routes {
	lookup(label: string): Promise<RouteTarget | null>;
	sshTarget(sandboxIdOrSlug: string): Promise<SshTarget | null>;
}

/** `core.routes` of S6 §14.2 over a pool. */
export function createRoutes(q: Queryable): Routes {
	return {
		lookup: (label) => lookupRoute(q, label),
		sshTarget: (idOrSlug) => sshTarget(q, idOrSlug),
	};
}
