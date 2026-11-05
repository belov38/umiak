import { isTrustedIngressClient, ownerSessionHeaders } from "@umiak/auth";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import {
	decodeTeamRef,
	personAuth,
	selectPersonTeam,
	TEAM_HEADER,
} from "./principal.ts";

/**
 * Applies even to metadata: owner mode is reachable only through the trusted
 * ingress. The check is on the socket peer, never on forwarded addresses: the
 * ingress has already admitted (and stamped) the real client.
 */
export function ownerNetworkGuard(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	let observed = 0;
	return async (c, next) => {
		const peer = (
			c.env as
				| { incoming?: { socket?: { remoteAddress?: string } } }
				| undefined
		)?.incoming?.socket?.remoteAddress;
		if (observed++ < 10)
			deps.log.info(
				{ clientIp: c.var.clientIp, peer },
				"owner mode observed peer and client address",
			);
		if (
			!isTrustedIngressClient(peer ?? "", {
				allowed: deps.settings.localAllowedCidrs,
				denied: deps.settings.localDeniedCidrs ?? [],
			})
		)
			throw new ApiError(
				403,
				"ingress_required",
				"owner mode accepts requests from the trusted ingress only",
			);
		if (
			!deps.settings.ownerHosts.includes(
				c.req.header("host")?.toLowerCase() ?? "",
			)
		)
			throw new ApiError(
				403,
				"host_forbidden",
				"Host must match the configured API or app authority",
			);
		await next();
	};
}

export async function ownerAuthenticate(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	requested?: string | null,
) {
	// CLI/SDK calls have no Origin. Browsers must use the configured app origin,
	// and simple cross-site form bodies must never invoke owner authority.
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
				"HTML form content types are not accepted in owner mode",
			);
	}
	const s = await deps.sessions.resolve(ownerSessionHeaders());
	const header = c.req.header(TEAM_HEADER);
	const team = await selectPersonTeam(
		deps.identity,
		s,
		requested === undefined
			? header === undefined
				? null
				: decodeTeamRef(header, "header.umiak-team")
			: requested,
		s.isOperator,
	);
	return personAuth("session", s, team, null);
}
