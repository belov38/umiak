// Route guards (S7 §7.3, §7.5). Put them in `createRoute({middleware: [...]})`
// (they run before validation) or before a plain handler. They read
// `c.var.auth`, set by the listener's authentication.
import type { Scope } from "@umiak/auth";
import { hasOperatorRights } from "@umiak/core";
import type { MiddlewareHandler } from "hono";
import type { ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { authOf } from "./principal.ts";

/** 403 forbidden with `details.requiredScope` unless `p` has the scope. */
export function checkScope(
	p: { scopes: readonly Scope[] },
	scope: Scope,
): void {
	if (!p.scopes.includes(scope)) {
		throw new ApiError(
			403,
			"forbidden",
			`the API key lacks the scope ${scope}; a team owner can issue a key with it`,
			{ details: { requiredScope: scope } },
		);
	}
}

/** Route guard of `checkScope`. */
export function requireScope(scope: Scope): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		checkScope(authOf(c).principal, scope);
		await next();
	};
}

function userRequired(): ApiError {
	return new ApiError(
		403,
		"forbidden",
		"only a person can do this (browser session or `umiak login`), not a team API key",
		{ details: { reason: "user_required" } },
	);
}

/** 403 `user_required` for team keys (SSH keys of a user, issuing keys). */
export function requireHuman(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (authOf(c).principal.userId === null) throw userRequired();
		await next();
	};
}

function ownerRequired(): ApiError {
	return new ApiError(
		403,
		"forbidden",
		"only an owner of the team can do this",
		{
			details: { reason: "role" },
		},
	);
}

/** A person with the `owner` role in the request's team; else 403 `user_required` or `role`. */
export function requireOwner(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const p = authOf(c).principal;
		if (p.userId === null) throw userRequired();
		if (p.role !== "owner") throw ownerRequired();
		await next();
	};
}

/**
 * A person needs the `owner` role (403 `role`) or platform operator rights
 * (S8 §6.2: operators manage any team's environments, and remove them
 * before a team delete, §6.4); a team key passes, its scopes stand in for
 * the role (an owner chose them, §7.5). Use after `requireScope`.
 */
export function requireOwnerUnlessKey(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const p = authOf(c).principal;
		if (p.kind !== "team_key" && p.role !== "owner" && !hasOperatorRights(p)) {
			throw ownerRequired();
		}
		await next();
	};
}

/**
 * Operator-only routes (S8 C3): 403 `operator_required` unless the caller is
 * a platform operator's browser session (C6: never a team key). Runs before the path is resolved, so nothing about the sandbox
 * leaks; core checks again.
 */
export function requireOperator(): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		if (!hasOperatorRights(authOf(c).principal)) {
			throw new ApiError(
				403,
				"forbidden",
				"only a platform operator (dashboard session) can do this",
				{ details: { reason: "operator_required" } },
			);
		}
		await next();
	};
}
