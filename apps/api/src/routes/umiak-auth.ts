// GET /umiak-auth/authorize?label=&state= on the proxied listener (S7 §7.7,
// S4 §8.4, S8 C7): the gateway sends a browser here, behind owner ingress,
// to open an `sso` port. A signed-in user allowed by the platform policy
// gets a one-time code (32 random bytes, only its sha256 is stored, 60 s)
// and a 302 to the callback of the port's host, built from the label, never
// from the request. Anything else is a small self-contained HTML page
// (this is a browser navigation, not an API call), with no redirect.
import { randomBytes } from "node:crypto";
import { lookupRoute, parseLabel } from "@umiak/core";
import type { Context } from "hono";
import { authOf } from "../auth/principal.ts";
import { proxiedAuth } from "../auth/proxied.ts";
import { rateLimit } from "../auth/rate-limit.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { lookupDesktopRoute } from "../desktop/service.ts";
import { ApiError, retryAfterSecondsOf, toHttpError } from "../http/errors.ts";
import { REQUEST_ID_HEADER } from "../http/request-id.ts";
import { poolOf } from "./internal/common.ts";
import {
	PORT_AUTH_CODE_TTL_SECONDS,
	portAuthCodeHash,
} from "./internal/port-auth.ts";
import { toGatewayRoute } from "./internal/routes.ts";

/** The gateway's state is 16 random bytes in base64url (S4 §8.4). */
const STATE_RE = /^[A-Za-z0-9_-]{1,128}$/;

const noop = async () => {};

function page(status: number, code: string, message: string): ApiError {
	return new ApiError(status, code, message);
}

function escapeHtml(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(ch) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				ch
			] as string,
	);
}

/** The error page: no scripts, styles, images or links. */
function errorPage(c: Context<ApiEnv>, e: ApiError): Response {
	c.set("errorCode", e.code);
	const message =
		e.status >= 500
			? "Something went wrong. Try again later."
			: escapeHtml(e.message);
	const html = [
		"<!doctype html>",
		'<html lang="en"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		"<title>Cannot open this page</title></head><body>",
		"<h1>Cannot open this page</h1>",
		`<p>${message}</p>`,
		`<p>Request id: ${escapeHtml(c.var.requestId)}</p>`,
		"</body></html>",
		"",
	].join("\n");
	const retry =
		e.status === 429 || e.status === 503
			? { "Retry-After": String(retryAfterSecondsOf(e)) }
			: {};
	return c.html(html, e.status as 400, {
		...(e.headers ?? {}),
		...retry,
		[REQUEST_ID_HEADER]: c.var.requestId,
		"Cache-Control": "no-store",
		"Content-Security-Policy": "default-src 'none'",
	});
}

async function authorize(c: Context<ApiEnv>, deps: ApiDeps): Promise<Response> {
	// The listener's authentication and rate limit, run here so that their
	// errors become the HTML page as well.
	await proxiedAuth(deps)(c, noop);
	await rateLimit(deps)(c, noop);
	const label = c.req.query("label") ?? "";
	const state = c.req.query("state") ?? "";
	if (label === "") throw page(400, "validation", "The link has no label.");
	if (!STATE_RE.test(state)) {
		throw page(400, "validation", "The link has no valid state.");
	}
	if (parseLabel(label) === null) {
		throw page(
			400,
			"validation",
			"This is not a port address of the platform.",
		);
	}
	const desktop = await lookupDesktopRoute(deps, label);
	const t = desktop
		? { teamId: desktop.rawTeamId }
		: await lookupRoute(poolOf(deps), label);
	if (t === null) {
		throw page(404, "route_not_found", "This port is not published.");
	}
	const d = await deps.config.defaults();
	const route =
		desktop ??
		toGatewayRoute(label, t as Parameters<typeof toGatewayRoute>[1], d);
	if (route.access !== "sso") {
		throw page(
			400,
			"validation",
			"This port does not use platform sign-in; open it with its own link.",
		);
	}
	if (route.blocked) {
		throw page(403, "forbidden", "This port is blocked by the platform.");
	}
	const a = authOf(c);
	{
		const inTeam = a.teams.some((m) => m.teamId === t.teamId);
		if (!inTeam && !a.principal.isOperator) {
			throw page(
				403,
				"forbidden",
				"Only members of the sandbox's team may open this port.",
			);
		}
	}
	const user = a.user;
	if (user === null) throw new Error("umiak-auth: a session without a user");
	const code = randomBytes(32).toString("base64url");
	await poolOf(deps).query(
		`INSERT INTO runtime.port_auth_codes (code_hash, label, user_id, email, auth_epoch, expires_at)
		 VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
		[
			portAuthCodeHash(code),
			label,
			user.id,
			user.email,
			route.authEpoch,
			PORT_AUTH_CODE_TTL_SECONDS,
		],
	);
	const callback = new URL(
		`https://${label}.${deps.settings.umiakDomain}/__umiak/auth/callback`,
	);
	callback.searchParams.set("code", code);
	callback.searchParams.set("state", state);
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return c.redirect(callback.toString(), 302);
}

export function registerUmiakAuthRoutes(app: ApiApp, deps: ApiDeps): void {
	app.get("/umiak-auth/authorize", async (c) => {
		try {
			return await authorize(c, deps);
		} catch (e) {
			const err = toHttpError(e);
			if (err.status >= 500) {
				deps.log.error(
					{
						requestId: c.var.requestId,
						err: e instanceof Error ? e.message : String(e),
					},
					"umiak-auth authorize failed",
				);
			}
			return errorPage(c, err);
		}
	});
}
