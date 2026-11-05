// Authentication of the proxied listener (S7 §7.4, S8 §5.2, C4, C6): the
// browser behind oauth2-proxy. Only oauth2-proxy reaches this port
// (NetworkPolicy), so its X-Auth-Request-* headers are trusted here.

import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import { ownerAuthenticate } from "./owner.ts";
import {
	type AuthContext,
	decodeTeamRef,
	needsAuth,
	TEAM_HEADER,
} from "./principal.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Content types a cross-site HTML form can send without CORS. */
const FORM_TYPES = [
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
];

function isUpgrade(c: Context<ApiEnv>): boolean {
	return c.req.header("upgrade")?.toLowerCase() === "websocket";
}

export function proxiedAuth(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (!needsAuth(c)) return next();
		try {
			checkRequest(deps, c);
			c.set("auth", await authenticate(deps, c));
		} catch (e) {
			const code = (e as { code?: unknown }).code;
			deps.metrics.authFailures.inc({
				reason: typeof code === "string" ? code : "internal",
			});
			throw e;
		}
		await next();
	};
}

/** Header rules that need no identity: Authorization, CSRF (Origin, form bodies). */
function checkRequest(deps: ApiDeps, c: Context<ApiEnv>): void {
	if (c.req.header("authorization") !== undefined) {
		throw validationError([
			{
				path: "header.authorization",
				message:
					"not accepted on this host; the browser session is the credential (use api.<domain> for bearer tokens)",
			},
		]);
	}
	const unsafe = !SAFE_METHODS.has(c.req.method);
	if (unsafe || isUpgrade(c)) {
		if (c.req.header("origin") !== deps.settings.appOrigin) {
			throw new ApiError(
				403,
				"origin_forbidden",
				"the Origin header must be the dashboard origin for this request",
			);
		}
	}
	if (unsafe) {
		const type = c.req.header("content-type")?.toLowerCase() ?? "";
		if (FORM_TYPES.some((t) => type.startsWith(t))) {
			throw validationError([
				{
					path: "header.content-type",
					message: "must be application/json (or the type of the file upload)",
				},
			]);
		}
	}
}

/** Team of the request: Umiak-Team, or `?team=` on GET/HEAD/upgrade (C4). */
export function requestedTeam(c: Context<ApiEnv>): string | null {
	const header = c.req.header(TEAM_HEADER);
	const query = c.req.query("team");
	const fromHeader =
		header === undefined ? null : decodeTeamRef(header, "header.umiak-team");
	if (query === undefined) return fromHeader;
	const readOnly = c.req.method === "GET" || c.req.method === "HEAD";
	if (!readOnly && !isUpgrade(c)) {
		throw validationError([
			{
				path: "query.team",
				message:
					"accepted only on GET, HEAD and WebSocket upgrades; send the Umiak-Team header",
			},
		]);
	}
	const fromQuery = decodeTeamRef(query, "query.team");
	if (fromHeader !== null && fromHeader !== fromQuery) {
		throw validationError([
			{ path: "query.team", message: "differs from the Umiak-Team header" },
		]);
	}
	return fromQuery;
}

async function authenticate(
	deps: ApiDeps,
	c: Context<ApiEnv>,
): Promise<AuthContext> {
	return ownerAuthenticate(deps, c, requestedTeam(c));
}
