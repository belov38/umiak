// Shared part of the server actions of S8 §9.11. Each action is a
// `"use server"` wrapper (src/actions/*) over an …Impl(ctx, args) here, so
// tests run the Impl against Postgres and Payload without Next.
//
// Every Impl runs in one Payload transaction (inTransaction: createLocalReq
// + initTransaction / commitTransaction / killTransaction). Permissions are
// read from `memberships` inside it, after the team row is locked
// (FOR NO KEY UPDATE, the lock the last-owner hook takes too), so actions
// on one team serialize and a role cannot change between the check and the
// write. Writes go through the Local API with overrideAccess and that req:
// the collection hooks (last owner, NOTIFY) run in the same transaction.
//
// Error codes: `forbidden`, `not_found`, `validation`, `last_owner`,
// `team_limit`, `already_member`. A row the caller may not act on, or one
// that does not exist, is `forbidden` for people: they never learn whether
// a foreign team, membership or notice exists. Operators, who may see every
// team, get `not_found` for a missing row. A malformed id is `validation`.
import type { SessionIdentity } from "@sbx/auth";
import { inTransaction, rows, sql, tbl, uniqueViolation } from "@sbx/payload";
import type { Payload, PayloadRequest } from "payload";
import type { z } from "zod";
import type { PermissionTeam, TeamRole } from "../permissions";

export interface ActionCtx {
	payload: Payload;
	/** The resolved browser session (UUIDs); only user.id and isOperator are trusted. */
	session: SessionIdentity;
}

export type ActionErrorCode =
	| "forbidden"
	| "not_found"
	| "validation"
	| "last_owner"
	| "team_limit"
	| "already_member";

export interface ActionError {
	error: { code: ActionErrorCode; message: string };
}

// biome-ignore lint/complexity/noBannedTypes: the default is "no extra fields"
export type ActionResult<T extends object = {}> =
	| ({ ok: true } & T)
	| ActionError;

export function fail(code: ActionErrorCode, message: string): ActionError {
	return { error: { code, message } };
}

export const FORBIDDEN = "You do not have permission to do this.";

/** Parses args with zod; the first issue is the message. */
export function parse<S extends z.ZodType>(
	schema: S,
	args: unknown,
): { ok: true; data: z.infer<S> } | ActionError {
	const r = schema.safeParse(args);
	if (r.success) return { ok: true, data: r.data };
	const i = r.error.issues[0];
	const where = i && i.path.length > 0 ? `${i.path.join(".")}: ` : "";
	return fail("validation", `${where}${i?.message ?? "invalid input"}`);
}

/** Thrown inside the transaction to roll it back with an error result. */
class Rollback extends Error {
	readonly result: ActionError;
	constructor(result: ActionError) {
		super(result.error.code);
		this.result = result;
	}
}

const ATTEMPTS = 3;

const LAST_OWNER_MESSAGE =
	"A team needs at least one owner: make someone else owner first.";

function isLastOwner(e: unknown): boolean {
	return e instanceof Error && e.message === "last_owner";
}

/**
 * Runs `fn` in a transaction. An error result rolls everything back. The
 * last-owner hook (APIError "last_owner") becomes `last_owner`. A unique
 * violation (a concurrent invite of the same email) retries the whole
 * action, which then finds the other row.
 */
export async function inAction<T extends object>(
	ctx: ActionCtx,
	fn: (req: PayloadRequest) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await inTransaction(ctx.payload, async (req) => {
				const r = await fn(req);
				if ("error" in r) throw new Rollback(r);
				return r;
			});
		} catch (e) {
			if (e instanceof Rollback) return e.result;
			if (isLastOwner(e)) return fail("last_owner", LAST_OWNER_MESSAGE);
			if (attempt < ATTEMPTS && uniqueViolation(e)) continue;
			throw e;
		}
	}
}

export interface LockedTeam {
	id: string;
	name: string;
	personal: boolean;
}

/** The team row, locked for the rest of the transaction; null if missing. */
export async function lockTeam(
	req: PayloadRequest,
	teamId: string,
): Promise<LockedTeam | null> {
	const r = await rows<{ id: string; name: string; personal: boolean | null }>(
		req.payload,
		sql`SELECT id, name, personal FROM ${tbl(req.payload, "teams")}
		     WHERE id = ${teamId} FOR NO KEY UPDATE`,
		req,
	);
	const t = r[0];
	return t ? { id: t.id, name: t.name, personal: t.personal === true } : null;
}

export interface MembershipRow {
	id: string;
	userId: string;
	teamId: string;
	role: TeamRole;
}

const MEMBERSHIP_COLS = sql.raw(
	`id, user_id AS "userId", team_id AS "teamId", role`,
);

/** The membership of `userId` in `teamId`, or null. */
export async function membershipOf(
	req: PayloadRequest,
	teamId: string,
	userId: string,
): Promise<MembershipRow | null> {
	const r = await rows<MembershipRow & Record<string, unknown>>(
		req.payload,
		sql`SELECT ${MEMBERSHIP_COLS} FROM ${tbl(req.payload, "memberships")}
		     WHERE team_id = ${teamId} AND user_id = ${userId}`,
		req,
	);
	return r[0] ?? null;
}

export async function membershipById(
	req: PayloadRequest,
	id: string,
): Promise<MembershipRow | null> {
	const r = await rows<MembershipRow & Record<string, unknown>>(
		req.payload,
		sql`SELECT ${MEMBERSHIP_COLS} FROM ${tbl(req.payload, "memberships")}
		     WHERE id = ${id}`,
		req,
	);
	return r[0] ?? null;
}

/** A row that is missing: not_found for operators, forbidden for people. */
export function missing(ctx: ActionCtx, what: string): ActionError {
	return ctx.session.isOperator
		? fail("not_found", `${what} not found.`)
		: fail("forbidden", FORBIDDEN);
}

export interface TeamAccess {
	ok: true;
	team: LockedTeam;
	/** The caller's membership; null for an operator outside the team. */
	membership: MembershipRow | null;
	role: TeamRole | null;
	perm: PermissionTeam;
}

/**
 * Locks the team and reads the caller's membership in it. A missing team is
 * `missing()`; a team the caller is not in (and is no operator) is
 * `forbidden`.
 */
export async function teamAccess(
	ctx: ActionCtx,
	req: PayloadRequest,
	teamId: string,
): Promise<TeamAccess | ActionError> {
	const team = await lockTeam(req, teamId);
	if (team === null) return missing(ctx, "Team");
	const m = await membershipOf(req, teamId, ctx.session.user.id);
	if (m === null && !ctx.session.isOperator) {
		return fail("forbidden", FORBIDDEN);
	}
	const role = m?.role ?? null;
	return {
		ok: true,
		team,
		membership: m,
		role,
		perm: { role, personal: team.personal },
	};
}

/**
 * After a user leaves `teamId` (or is removed), a default team that was
 * `teamId` falls back to the personal team (S8 §6.1); a stub without one
 * gets none.
 */
export async function resetDefaultTeam(
	req: PayloadRequest,
	userId: string,
	teamId: string,
): Promise<void> {
	const u = await req.payload.findByID({
		collection: "users",
		id: userId,
		depth: 0,
		req,
		overrideAccess: true,
		disableErrors: true,
	});
	if (!u || relationId(u.defaultTeam) !== teamId) return;
	await req.payload.update({
		collection: "users",
		id: userId,
		data: { defaultTeam: relationId(u.personalTeam) },
		depth: 0,
		req,
		overrideAccess: true,
	});
}

/** The id of a relationship value (an id or a populated document). */
export function relationId(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "object") {
		const id = (v as { id?: unknown }).id;
		return id === null || id === undefined ? null : String(id);
	}
	return String(v);
}
