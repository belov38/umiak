// GET /internal/v1/gateway/routes/{label} (S7 §12.1, S4 §6.1, S8 C7): the
// hosted port of a label in the S4 shape plus `kind`. The gateway takes no
// policy decisions: blocks, `public_disabled` and the sso epoch are computed
// here, with the platform defaults read on every lookup (no cache, C7).
import { encodeUuid } from "@umiak/auth";
import type { PlatformDefaults } from "@umiak/config";
import { lookupRoute, type RouteTarget } from "@umiak/core";
import type { ApiApp, ApiDeps } from "../../deps.ts";
import { lookupDesktopRoute } from "../../desktop/service.ts";
import { ApiError } from "../../http/errors.ts";
import { poolOf, requireGateway } from "./common.ts";

export interface GatewayRoute {
	label: string;
	sandboxId: string;
	slug: string;
	port: number;
	machineId: string | null;
	/** The S6 state as is (S7 §12.1 overrides S4 §6.3). */
	sandboxState: string;
	access: RouteTarget["mode"];
	tokenHash: string | null;
	authEpoch: number;
	blocked: boolean;
	blockReason: string | null;
	hostRewrite: RouteTarget["hostRewrite"];
	appProtocol: RouteTarget["appProtocol"];
	teamId: string;
	/** `desktop` routes come with S10; desktop labels are 404 until then. */
	kind: "port";
}

/**
 * The route answer of a core target. `sso` routes add `ssoPolicyEpoch` to
 * their epoch (C7), so a policy change invalidates the sso cookies; `public`
 * routes are blocked while public ports are off, unless already blocked
 * for another reason.
 */
export function toGatewayRoute(
	label: string,
	t: RouteTarget,
	d: Pick<PlatformDefaults, "publicPortsEnabled" | "ssoPolicyEpoch">,
): GatewayRoute {
	const publicDisabled = t.mode === "public" && !d.publicPortsEnabled;
	return {
		label,
		sandboxId: encodeUuid("sandbox", t.sandboxId),
		slug: t.slug,
		port: t.port,
		machineId: t.machineId,
		sandboxState: t.state,
		access: t.mode,
		tokenHash: t.tokenHash,
		authEpoch: t.mode === "sso" ? t.authEpoch + d.ssoPolicyEpoch : t.authEpoch,
		blocked: t.blocked || publicDisabled,
		blockReason: t.blocked
			? t.blockReason
			: publicDisabled
				? "public_disabled"
				: null,
		hostRewrite: t.hostRewrite,
		appProtocol: t.appProtocol,
		teamId: encodeUuid("team", t.teamId),
		kind: "port",
	};
}

function routeNotFound(): ApiError {
	return new ApiError(404, "route_not_found", "no route for this label");
}

export function registerGatewayRouteRoutes(app: ApiApp, deps: ApiDeps): void {
	app.get("/internal/v1/gateway/routes/:label", requireGateway(), async (c) => {
		const label = c.req.param("label");
		// Outside the grammar, desktop labels, reserved slugs, unknown slug,
		// unhosted port and deleted sandboxes are all null.
		const desktop = await lookupDesktopRoute(deps, label);
		if (desktop) {
			const { rawSandboxId: _, rawTeamId: __, ...route } = desktop;
			return c.json(route, 200);
		}
		const t = await lookupRoute(poolOf(deps), label);
		if (t === null) throw routeNotFound();
		const d = await deps.config.defaults();
		return c.json(toGatewayRoute(label, t, d), 200);
	});
}
