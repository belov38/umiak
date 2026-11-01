import { z } from "zod";
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { validDesktopGrant } from "../../desktop/revocation.ts";
import {
	desktopRpc,
	lookupDesktopRoute,
	ticketHash,
} from "../../desktop/service.ts";
import { ApiError } from "../../http/errors.ts";
import { poolOf, readJson, requireGateway } from "./common.ts";

export function registerDesktopInternalRoutes(app: ApiApp, deps: ApiDeps) {
	app.post("/internal/v1/gateway/desktop/open", requireGateway(), async (c) => {
		const { label } = await readJson(c, z.object({ label: z.string() }));
		const rt = await lookupDesktopRoute(deps, label);
		if (!rt)
			throw new ApiError(404, "route_not_found", "desktop route not found");
		if (rt.blocked)
			throw new ApiError(403, "route_blocked", "desktop is blocked");
		if (rt.sandboxState !== "ready" || !rt.machineId)
			throw new ApiError(409, "desktop_not_ready", "desktop is not ready");
		await deps.svc.touchApiActivity(rt.rawSandboxId);
		return c.json(await desktopRpc(deps, rt.machineId, "open"));
	});
	app.post(
		"/internal/v1/gateway/desktop/tickets/exchange",
		requireGateway(),
		async (c) => {
			const { ticket, label } = await readJson(
				c,
				z.object({ ticket: z.string(), label: z.string() }),
			);
			const invalid = () =>
				new ApiError(
					401,
					"invalid_code",
					"desktop ticket is invalid or expired",
				);
			if (!/^sbxd_[A-Za-z0-9_-]{43}$/.test(ticket)) throw invalid();
			const rt = await lookupDesktopRoute(deps, label);
			if (!rt || rt.blocked || rt.sandboxState !== "ready") throw invalid();
			const record = await poolOf(deps).query<{
				user_id: string | null;
				api_key_id: string | null;
				created_at: Date;
			}>(
				"SELECT user_id,api_key_id,created_at FROM runtime.desktop_tickets WHERE ticket_hash=$1 AND sandbox_id=$2 AND label=$3 AND auth_epoch=$4 AND used_at IS NULL AND expires_at>now()",
				[ticketHash(ticket), rt.rawSandboxId, label, rt.authEpoch],
			);
			const t = record.rows[0];
			if (!t) throw invalid();
			if (!(await validDesktopGrant(deps, t, rt.rawTeamId))) throw invalid();
			const consumed = await poolOf(deps).query(
				`UPDATE runtime.desktop_tickets t SET used_at=now() FROM runtime.sandbox_desktops d WHERE t.ticket_hash=$1 AND t.sandbox_id=d.sandbox_id AND t.label=$2 AND t.auth_epoch=d.auth_epoch AND t.auth_epoch=$3 AND t.used_at IS NULL AND t.expires_at>now() RETURNING t.user_id`,
				[ticketHash(ticket), label, rt.authEpoch],
			);
			if (consumed.rowCount !== 1) throw invalid();
			return c.json({
				userId: t.user_id ?? "",
				label,
				authEpoch: rt.authEpoch,
			});
		},
	);
}
