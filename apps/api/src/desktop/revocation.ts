import type { ApiDeps } from "../deps.ts";
import { poolOf } from "../routes/internal/common.ts";
import { desktopRpc } from "./service.ts";

type Grant = {
	user_id: string | null;
	api_key_id: string | null;
	created_at: Date;
};
/** Rechecked on exchange and while a cookie issued from this grant can be live. */
export async function validDesktopGrant(
	deps: ApiDeps,
	grant: Grant,
	teamId: string,
): Promise<boolean> {
	if (grant.api_key_id) {
		const key = await deps.identity.apiKey(grant.api_key_id);
		return (
			!!key &&
			!key.revokedAt &&
			key.expiresAt.getTime() > Date.now() &&
			key.teamId === teamId &&
			key.scopes.includes("desktop") &&
			(!key.rotatedAt || key.rotatedAt <= grant.created_at)
		);
	}
	if (grant.user_id) {
		const user = await deps.identity.user(grant.user_id);
		return (
			!!user?.active &&
			(user.isOperator ||
				(await deps.identity.membership(grant.user_id, teamId)) !== null)
		);
	}
	return false;
}
export async function disconnectDesktop(
	deps: ApiDeps,
	id: string,
	machineId: string | null,
): Promise<void> {
	const policy = await poolOf(deps).query<{ auth_epoch: number }>(
		"SELECT auth_epoch FROM runtime.sandbox_desktops WHERE sandbox_id=$1 AND pending_disconnect",
		[id],
	);
	const epoch = policy.rows[0]?.auth_epoch;
	if (epoch === undefined) return;
	if (machineId) await desktopRpc(deps, machineId, "endStreams");
	await poolOf(deps).query(
		"UPDATE runtime.sandbox_desktops SET pending_disconnect=false WHERE sandbox_id=$1 AND auth_epoch=$2",
		[id, epoch],
	);
}
/** Epoch invalidation is durable before contacting a potentially unavailable guest. */
export async function revokeDesktop(
	deps: ApiDeps,
	id: string,
	machineId: string | null,
	epoch?: number,
): Promise<void> {
	const changed = await poolOf(deps).query(
		"UPDATE runtime.sandbox_desktops SET auth_epoch=auth_epoch+1,pending_disconnect=true,updated_at=now() WHERE sandbox_id=$1 AND ($2::int IS NULL OR auth_epoch=$2)",
		[id, epoch ?? null],
	);
	if (changed.rowCount) await disconnectDesktop(deps, id, machineId);
}
/** Also catches key expiry without a database notification. */
export async function recheckDesktopAccess(deps: ApiDeps): Promise<void> {
	const publicEnabled =
		(await deps.config.defaults()).publicDesktopEnabled === true;
	const routes = await poolOf(deps).query<{
		sandbox_id: string;
		machine_id: string | null;
		auth_epoch: number;
		access: string;
		blocked: boolean;
		template_slug: string;
		policy_revoked: boolean;
	}>(
		"SELECT d.sandbox_id,s.machine_id,d.auth_epoch,d.access,s.blocked,s.template_slug,d.policy_revoked FROM runtime.sandbox_desktops d JOIN runtime.sandboxes s ON s.id=d.sandbox_id WHERE s.state='ready'",
	);
	for (const route of routes.rows) {
		const denied =
			route.blocked ||
			(route.access === "public" && !publicEnabled) ||
			!(await deps.config.template(route.template_slug))?.capabilities.includes(
				"desktop",
			);
		if (denied && !route.policy_revoked) {
			await poolOf(deps).query(
				"UPDATE runtime.sandbox_desktops SET auth_epoch=auth_epoch+1,pending_disconnect=true,policy_revoked=true,updated_at=now() WHERE sandbox_id=$1 AND auth_epoch=$2 AND NOT policy_revoked",
				[route.sandbox_id, route.auth_epoch],
			);
		} else if (!denied && route.policy_revoked) {
			// A link issued while the block was being applied carries the epoch of the
			// block; advancing again keeps it dead after unblock.
			await poolOf(deps).query(
				"UPDATE runtime.sandbox_desktops SET auth_epoch=auth_epoch+1,policy_revoked=false,updated_at=now() WHERE sandbox_id=$1 AND auth_epoch=$2",
				[route.sandbox_id, route.auth_epoch],
			);
		}
	}

	const grants = await poolOf(deps).query<
		Grant & {
			sandbox_id: string;
			team_id: string;
			machine_id: string | null;
			auth_epoch: number;
		}
	>(
		`SELECT t.user_id,t.api_key_id,t.created_at,t.sandbox_id,s.team_id,s.machine_id,d.auth_epoch FROM runtime.desktop_tickets t JOIN runtime.sandbox_desktops d ON d.sandbox_id=t.sandbox_id AND d.auth_epoch=t.auth_epoch JOIN runtime.sandboxes s ON s.id=t.sandbox_id WHERE s.state='ready'`,
	);
	for (const grant of grants.rows) {
		if (!(await validDesktopGrant(deps, grant, grant.team_id))) {
			try {
				await revokeDesktop(
					deps,
					grant.sandbox_id,
					grant.machine_id,
					grant.auth_epoch,
				);
			} catch {
				deps.log.debug("desktop disconnect will retry");
			}
		}
	}
	const pending = await poolOf(deps).query<{
		sandbox_id: string;
		machine_id: string | null;
	}>(
		"SELECT d.sandbox_id,s.machine_id FROM runtime.sandbox_desktops d JOIN runtime.sandboxes s ON s.id=d.sandbox_id WHERE d.pending_disconnect",
	);
	for (const row of pending.rows) {
		try {
			await disconnectDesktop(deps, row.sandbox_id, row.machine_id);
		} catch {
			deps.log.debug("desktop disconnect still pending");
		}
	}
}
/** Production lifecycle owns this monitor; harness apps do not start timers. */
export function watchDesktopAccess(deps: ApiDeps): () => Promise<void> {
	let closed = false;
	let running: Promise<void> | undefined;
	const check = () => {
		if (closed || running) return;
		running = recheckDesktopAccess(deps)
			.catch(() => deps.log.warn("desktop access recheck failed"))
			.finally(() => {
				running = undefined;
			});
	};
	const unsubscribe = deps.identityEvents.subscribe(check);
	const timer = setInterval(check, 5000);
	timer.unref();
	return async () => {
		closed = true;
		clearInterval(timer);
		unsubscribe();
		await running;
	};
}
