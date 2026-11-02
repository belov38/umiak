import { isLocalClientAllowed, localSessionHeaders } from "@umiak/auth";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import {
	decodeTeamRef,
	personAuth,
	selectPersonTeam,
	TEAM_HEADER,
} from "./principal.ts";

/** Applies even to metadata: the local deployment is private to these networks. */
export function localNetworkGuard(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	let observed = 0;
	return async (c, next) => {
		if (deps.settings.authMode === "none" && observed++ < 10)
			deps.log.info(
				{
					clientIp: c.var.clientIp,
					peer: (
						c.env as
							| { incoming?: { socket?: { remoteAddress?: string } } }
							| undefined
					)?.incoming?.socket?.remoteAddress,
				},
				"local mode observed client address (may be Docker NAT)",
			);
		if (
			deps.settings.authMode === "none" &&
			!isLocalClientAllowed(c.var.clientIp, {
				UMIAK_LOCAL_ALLOWED_CIDRS: deps.settings.localAllowedCidrs.join(","),
				UMIAK_LOCAL_DENIED_CIDRS: deps.settings.localDeniedCidrs?.join(","),
			})
		)
			throw new ApiError(
				403,
				"local_network_forbidden",
				"client address is outside UMIAK_LOCAL_ALLOWED_CIDRS",
			);

		if (
			deps.settings.authMode === "none" &&
			!deps.settings.localAllowedHosts.includes(
				c.req.header("host")?.toLowerCase() ?? "",
			)
		)
			throw new ApiError(
				403,
				"local_host_forbidden",
				"Host must match the configured API or app authority (UMIAK_LOCAL_ALLOWED_HOSTS for additional hosts)",
			);
		await next();
	};
}

export async function localAuthenticate(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	requested?: string | null,
) {
	// CLI/SDK calls have no Origin. Browsers must use the configured app origin,
	// and simple cross-site form bodies must never invoke local authority.
	const origin = c.req.header("origin");
	if (origin !== undefined && origin !== deps.settings.appOrigin)
		throw new ApiError(
			403,
			"origin_forbidden",
			"Origin must match the dashboard origin",
		);
	if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
		const type = c.req.header("content-type")?.toLowerCase() ?? "";
		if (
			[
				"application/x-www-form-urlencoded",
				"multipart/form-data",
				"text/plain",
			].some((t) => type.startsWith(t))
		)
			throw new ApiError(
				403,
				"origin_forbidden",
				"HTML form content types are not accepted in local mode",
			);
	}
	const s = await deps.sessions.resolve(localSessionHeaders());
	const header = c.req.header(TEAM_HEADER);
	const team = await selectPersonTeam(
		deps.identity,
		s,
		requested === undefined
			? header === undefined
				? null
				: decodeTeamRef(header, "header.umiak-team")
			: requested,
		true,
	);
	return personAuth("session", s, team, null);
}
