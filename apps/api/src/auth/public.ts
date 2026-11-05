// Public API: scoped team API keys or the owner identity admitted by the private ingress.
// Client-supplied identity headers are discarded before authentication.
import { apiKeyHash, classifyBearer, isWellFormedApiKey } from "@umiak/auth";
import type { Context, MiddlewareHandler } from "hono";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ownerAuthenticate } from "./owner.ts";
import {
	type AuthContext,
	decodeTeamRef,
	invalidToken,
	keyAuth,
	needsAuth,
	TEAM_HEADER,
	teamForbidden,
} from "./principal.ts";
import { requestedTeam } from "./proxied.ts";

/** Headers only owner ingress may set; on the public host they are forged. */
export function isProxyIdentityHeader(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n.startsWith("x-auth-request-") ||
		n === "x-forwarded-user" ||
		n === "x-forwarded-email"
	);
}

/** Must be the first middleware of the public listener (anti-goal 4). */
export function stripProxyHeaders(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const h = c.req.raw.headers;
		const names = [...h.keys()].filter(isProxyIdentityHeader);
		for (const n of names) h.delete(n);
		await next();
	};
}

/** The bearer token, or null without an Authorization header. */
export function bearerOf(c: Context<ApiEnv>): string | null {
	const v = c.req.header("authorization");
	if (v === undefined) return null;
	const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(v);
	if (m === null) {
		throw invalidToken("the Authorization header must be `Bearer <token>`");
	}
	return m[1] as string;
}

export function publicAuth(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (!needsAuth(c)) return next();
		try {
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

async function authenticate(
	deps: ApiDeps,
	c: Context<ApiEnv>,
): Promise<AuthContext> {
	const token = bearerOf(c);
	if (token === null) return ownerAuthenticate(deps, c, requestedTeam(c));
	// Decoded after the credential passed: a stranger always gets a 401.
	const teamHeader = c.req.header(TEAM_HEADER);
	const requested = () =>
		teamHeader === undefined
			? null
			: decodeTeamRef(teamHeader, "header.umiak-team");
	switch (classifyBearer(token)) {
		case "team_key":
			return keyAuthenticate(deps, token, requested);
		default:
			throw invalidToken("the bearer is not a team API key");
	}
}

async function keyAuthenticate(
	deps: ApiDeps,
	secret: string,
	requested: () => string | null,
): Promise<AuthContext> {
	// Offline format and CRC check first: typos and random strings never
	// reach the store.
	if (!isWellFormedApiKey(secret)) {
		throw invalidToken("the API key is not valid");
	}
	const hit = await deps.keyCache.lookup(apiKeyHash(secret));
	if (hit === null || hit.key.revokedAt !== null) {
		throw invalidToken("the API key is not valid or has been revoked");
	}
	if (hit.key.expiresAt.getTime() <= Date.now()) {
		throw invalidToken(
			"the API key has expired; a team owner can issue a new one",
			"api_key_expired",
		);
	}
	const team = requested();
	if (team !== null && team !== hit.key.teamId) {
		throw teamForbidden("the API key belongs to another team than Umiak-Team");
	}
	deps.keyCache.touch(hit.key);
	return keyAuth(hit.key, hit.teamName);
}
