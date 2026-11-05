// Who is calling (S7 §7.5): the AuthContext of a request in `c.var.auth`,
// built by the listener's authentication middleware (public.ts, proxied.ts).
// Also the shared pieces of both: team selection, the cached session
// resolver and the 401/403 errors.
import { createHash } from "node:crypto";
import {
	type ApiKeyRecord,
	decodeUuid,
	IdentityError,
	type IdentityStore,
	SCOPES,
	type SessionHeaders,
	type SessionIdentity,
	type TeamMembership,
	type UserRecord,
} from "@umiak/auth";
import type { Principal } from "@umiak/core";
import type { Context } from "hono";
import { matchedRoutes } from "hono/route";
import type { ApiEnv } from "../deps.ts";
import { ApiError, validationError } from "../http/errors.ts";
import { ANONYMOUS_ROUTES } from "../routes/meta.ts";
import type { IdentityListener } from "./identity-listener.ts";

/** A team of the caller; `role` is null for team keys and operators outside the team. */
export interface AuthTeam {
	teamId: string;
	name: string;
	role: TeamMembership["role"] | null;
}

export interface AuthContext {
	principal: Principal;
	/** The person; null for team keys. */
	user: UserRecord | null;
	/** The team key; null for people. */
	apiKey: ApiKeyRecord | null;
	/** The team of this request (`principal.teamId`) with its name. */
	team: AuthTeam;
	/** The person's memberships; a key: its own team only. */
	teams: AuthTeam[];
	/** Expiry of the bearer (key or access token); null for browser sessions. */
	tokenExpiresAt: Date | null;
}

/** Header that selects the team of a request (`team_...`). */
export const TEAM_HEADER = "umiak-team";

/** The auth context of an authenticated route; throws if the route is anonymous. */
export function authOf(c: Context<ApiEnv>): AuthContext {
	const a = c.var.auth;
	if (a === undefined) {
		throw new Error("authOf: the route is not authenticated");
	}
	return a;
}

/** Paths of the listener-wide middleware (`app.use`); anything else is a route. */
const LISTENER_MIDDLEWARE_PATHS = new Set(["*", "/*", "/v1/*"]);

/**
 * Whether the listener's authentication applies: skipped only when every
 * matched route is anonymous (`/v1/meta`, `/v1/openapi.json`, `/v1/docs`)
 * or nothing but the listener-wide middleware matched (then the answer is
 * 404/405). A route registered with `app.all` or a wildcard path counts as
 * a route (authenticated).
 */
export function needsAuth(c: Context<ApiEnv>): boolean {
	return matchedRoutes(c).some(
		(r) =>
			(r.method !== "ALL" || !LISTENER_MIDDLEWARE_PATHS.has(r.path)) &&
			!ANONYMOUS_ROUTES.has(r.path),
	);
}

// --- errors ---

const REALM = 'Bearer realm="umiak"';

/** No credentials at all. */
export function authRequired(message = "authentication required"): ApiError {
	return new ApiError(401, "unauthorized", message, {
		headers: { "WWW-Authenticate": REALM },
	});
}

/** A bearer was presented and did not pass (RFC 6750 invalid_token). */
export function invalidToken(
	message: string,
	code: "unauthorized" | "token_expired" | "api_key_expired" = "unauthorized",
): ApiError {
	return new ApiError(401, code, message, {
		details: code === "unauthorized" ? { reason: "invalid_token" } : {},
		headers: { "WWW-Authenticate": `${REALM}, error="invalid_token"` },
	});
}

export function teamForbidden(message: string): ApiError {
	return new ApiError(403, "team_forbidden", message);
}

/** IdentityStore errors of resolveSession as HTTP (S8 §5.3, C8). */
export function identityErrorToHttp(e: unknown): unknown {
	if (!(e instanceof IdentityError)) return e;
	switch (e.code) {
		case "user_disabled":
			return new ApiError(
				403,
				"forbidden",
				"this account is deactivated; contact an operator",
				{ details: { reason: "user_disabled" } },
			);
		case "identity_conflict":
			return new ApiError(
				403,
				"forbidden",
				`${e.message}; contact an operator`,
				{ details: { reason: "identity_conflict" } },
			);
		case "subject_required":
			return authRequired("the identity provider sent no subject (sub)");
		default:
			return e;
	}
}

// --- team selection ---

/** `team_...` to UUID; anything else is a 400 (`where` names the input). */
export function decodeTeamRef(value: string, where: string): string {
	const id = decodeUuid("team", value.trim());
	if (id === null) {
		throw validationError([
			{ path: where, message: "must be a team id (team_...)" },
		]);
	}
	return id;
}

/**
 * Team of a person's request: the requested one if the person is a member
 * (or an operator in a browser session, for an existing team), else the
 * default team.
 */
export async function selectPersonTeam(
	identity: IdentityStore,
	s: SessionIdentity,
	requested: string | null,
	operator: boolean,
): Promise<AuthTeam> {
	if (requested === null) {
		const t = s.teams.find((m) => m.teamId === s.defaultTeamId) ?? s.teams[0];
		if (t === undefined) {
			throw teamForbidden("you are not a member of any team");
		}
		return t;
	}
	const own = s.teams.find((m) => m.teamId === requested);
	if (own !== undefined) return own;
	if (operator) {
		const t = await identity.team(requested);
		if (t !== null) return { teamId: t.id, name: t.name, role: null };
	}
	throw teamForbidden("you are not a member of the team in Umiak-Team");
}

/** AuthContext of a person (browser session or owner session). */
export function personAuth(
	kind: "session",
	s: SessionIdentity,
	team: AuthTeam,
	tokenExpiresAt: Date | null,
): AuthContext {
	// C6: operator rights only in a browser session.
	const isOperator = kind === "session" && s.isOperator;
	return {
		principal: {
			kind,
			userId: s.user.id,
			teamId: team.teamId,
			role: team.role,
			isOperator,
			scopes: SCOPES,
		},
		user: s.user,
		apiKey: null,
		team,
		// An operator's foreign team is not added: it is not a membership.
		teams: s.teams,
		tokenExpiresAt,
	};
}

/** AuthContext of a team key (S7 §7.2). */
export function keyAuth(key: ApiKeyRecord, teamName: string): AuthContext {
	return {
		principal: {
			kind: "team_key",
			userId: null,
			teamId: key.teamId,
			role: null,
			isOperator: false,
			apiKeyId: key.id,
			scopes: key.scopes,
		},
		user: null,
		apiKey: key,
		team: { teamId: key.teamId, name: teamName, role: null },
		teams: [{ teamId: key.teamId, name: teamName, role: null }],
		tokenExpiresAt: key.expiresAt,
	};
}

// --- sessions ---

export interface SessionResolverOptions {
	/** Default 30 s (S7 §7.4, S8 §5.3). */
	ttlMs?: number;
	now?: () => number;
}

/** Cached sessions before expired ones are pruned. */
const MAX_SESSIONS = 10_000;

/**
 * Collections whose changes do not affect a SessionIdentity. `sandboxes` is
 * not an identity collection: a sandbox block for the stream registry.
 */
const NOT_SESSION = new Set(["api-keys", "ssh-keys", "sandboxes"]);

/**
 * `IdentityStore.resolveSession` with a 30 s cache keyed by the claims
 * (email, sub, groups, names). Any change of users, teams or memberships
 * (NOTIFY umiak_identity) flushes it. Errors are not cached.
 */
export class SessionResolver {
	readonly #identity: IdentityStore;
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #cache = new Map<string, { at: number; s: SessionIdentity }>();
	#generation = 0;

	constructor(
		identity: IdentityStore,
		events: IdentityListener,
		o: SessionResolverOptions = {},
	) {
		this.#identity = identity;
		this.#ttlMs = o.ttlMs ?? 30_000;
		this.#now = o.now ?? Date.now;
		events.subscribe((c) => {
			if (c.all || !NOT_SESSION.has(c.collection)) this.flush();
		});
	}

	flush(): void {
		this.#generation++;
		this.#cache.clear();
	}

	/** Throws ApiError for disabled, conflicting or subject-less identities. */
	async resolve(h: SessionHeaders): Promise<SessionIdentity> {
		const key = sessionKey(h);
		const hit = this.#cache.get(key);
		const now = this.#now();
		if (hit !== undefined && now - hit.at < this.#ttlMs) return hit.s;
		const gen = this.#generation;
		let s: SessionIdentity;
		try {
			s = await this.#identity.resolveSession(h);
		} catch (e) {
			throw identityErrorToHttp(e);
		}
		// A change arrived while resolving: the answer may predate it.
		if (gen === this.#generation) {
			if (this.#cache.size >= MAX_SESSIONS) this.#prune(now);
			this.#cache.set(key, { at: now, s });
		}
		return s;
	}

	#prune(now: number): void {
		for (const [k, e] of this.#cache) {
			if (now - e.at >= this.#ttlMs) this.#cache.delete(k);
		}
		if (this.#cache.size >= MAX_SESSIONS) this.#cache.clear();
	}
}

function sessionKey(h: SessionHeaders): string {
	const groups = [...new Set(h.groups)].sort();
	return createHash("sha256")
		.update(
			JSON.stringify([
				h.email.trim().toLowerCase(),
				h.user ?? "",
				groups,
				h.preferredUsername ?? "",
				h.name ?? "",
			]),
		)
		.digest("hex");
}
