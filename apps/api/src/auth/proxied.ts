// Authentication of the proxied listener (S7 §7.4, S8 §5.2, C4, C6): the
// browser behind oauth2-proxy. Only oauth2-proxy reaches this port
// (NetworkPolicy), so its X-Auth-Request-* headers are trusted here.
import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import {
	type AuthContext,
	authRequired,
	decodeTeamRef,
	needsAuth,
	personAuth,
	selectPersonTeam,
	TEAM_HEADER,
} from "./principal.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Content types a cross-site HTML form can send without CORS. */
const FORM_TYPES = [
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"text/plain",
];

/** `X-Auth-Request-Groups`: comma-separated and/or repeated (Node joins repeats with ", "). */
export function parseGroups(v: string | undefined): string[] {
	if (v === undefined) return [];
	return [
		...new Set(
			v
				.split(",")
				.map((g) => g.trim())
				.filter((g) => g !== ""),
		),
	];
}

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

/** Team of the request: Sbx-Team, or `?team=` on GET/HEAD/upgrade (C4). */
function requestedTeam(c: Context<ApiEnv>): string | null {
	const header = c.req.header(TEAM_HEADER);
	const query = c.req.query("team");
	const fromHeader =
		header === undefined ? null : decodeTeamRef(header, "header.sbx-team");
	if (query === undefined) return fromHeader;
	const readOnly = c.req.method === "GET" || c.req.method === "HEAD";
	if (!readOnly && !isUpgrade(c)) {
		throw validationError([
			{
				path: "query.team",
				message:
					"accepted only on GET, HEAD and WebSocket upgrades; send the Sbx-Team header",
			},
		]);
	}
	const fromQuery = decodeTeamRef(query, "query.team");
	if (fromHeader !== null && fromHeader !== fromQuery) {
		throw validationError([
			{ path: "query.team", message: "differs from the Sbx-Team header" },
		]);
	}
	return fromQuery;
}

async function authenticate(
	deps: ApiDeps,
	c: Context<ApiEnv>,
): Promise<AuthContext> {
	const email = c.req.header("x-auth-request-email")?.trim() ?? "";
	if (email === "") {
		throw authRequired("no browser session (X-Auth-Request-Email is missing)");
	}
	const requested = requestedTeam(c);
	const user = c.req.header("x-auth-request-user");
	const preferredUsername = c.req.header("x-auth-request-preferred-username");
	const s = await deps.sessions.resolve({
		email,
		groups: parseGroups(c.req.header("x-auth-request-groups")),
		...(user === undefined ? {} : { user }),
		...(preferredUsername ? { preferredUsername } : {}),
	});
	const team = await selectPersonTeam(
		deps.identity,
		s,
		requested,
		s.isOperator,
	);
	return personAuth("session", s, team, null);
}
