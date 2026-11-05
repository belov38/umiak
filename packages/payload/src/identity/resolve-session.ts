// JIT of the user from IdP claims (S8 §5.3). One function for the Payload
// auth strategy in web, PayloadIdentityStore.resolveSession in api (browser
// sessions) and the owner session of CLI, SDK and MCP: the identity is the
// IdP `sub` everywhere.
//
// Everything runs in one Payload transaction: user rows are locked with
// SELECT ... FOR UPDATE, writes go through the Local API with the same req
// (hooks send NOTIFY umiak_identity in it). Concurrent first logins collide
// on the unique indexes of email and idpSubject; the loser retries and
// finds the winner's row.
import {
	IdentityError,
	personalTeamName,
	type SessionHeaders,
	type SessionIdentity,
	type TeamMembership,
	type UserRecord,
} from "@umiak/auth";
import type { Payload, PayloadRequest } from "payload";
import { relId } from "../hooks/doc.ts";
import {
	inTransaction,
	rows,
	sql,
	tbl,
	toDateOrNull,
	uniqueViolation,
} from "./db.ts";

export interface ResolveSessionOptions {
	/** IdP groups that make a user an operator (UMIAK_OPERATOR_GROUPS). */
	operatorGroups: readonly string[];
	/**
	 * Run in this request. With an open transaction the work joins it (the
	 * caller commits; a lost first-login race is not retried then, the
	 * error goes to the caller); without one a transaction is opened on it.
	 */
	req?: PayloadRequest;
}

/** Attempts when concurrent first logins collide. */
const RESOLVE_ATTEMPTS = 3;

/** lastLoginAt is written at most this often (S8 §5.3 item 5). */
export const LAST_LOGIN_INTERVAL_MS = 60_000;

interface UserRow extends Record<string, unknown> {
	id: string;
	email: string;
	name: string | null;
	active: boolean;
	is_operator: boolean;
	idp_subject: string | null;
	default_team_id: string | null;
	personal_team_id: string | null;
	preferred_username: string | null;
	groups: unknown;
	last_login_at: unknown;
}

const USER_COLS = sql.raw(
	"id, email, name, active, is_operator, idp_subject, default_team_id, personal_team_id, preferred_username, groups, last_login_at",
);

export function userRecordOf(r: {
	id: string;
	email: string;
	name: string | null;
	active: boolean | null;
	is_operator: boolean | null;
	idp_subject: string | null;
	default_team_id: string | null;
}): UserRecord {
	return {
		id: r.id,
		email: r.email,
		name: r.name,
		active: r.active !== false,
		isOperator: r.is_operator === true,
		idpSubject: r.idp_subject,
		defaultTeamId: r.default_team_id,
	};
}

// S8 §5.3: name, else preferred username, else the local part of the email.
function displayName(email: string, h: SessionHeaders): string {
	return h.name ?? h.preferredUsername ?? email.split("@")[0] ?? email;
}

function sameSet(a: unknown, b: readonly string[]): boolean {
	if (!Array.isArray(a)) return false;
	const x = new Set(a.map(String));
	return x.size === new Set(b).size && b.every((g) => x.has(g));
}

/**
 * S8 §5.3 items 1–6. Throws IdentityError `subject_required` (no `sub`),
 * `user_disabled`, `identity_conflict`.
 */
export async function resolveSession(
	payload: Payload,
	h: SessionHeaders,
	o: ResolveSessionOptions,
): Promise<SessionIdentity> {
	const sub = h.user?.trim() ?? "";
	if (sub === "") throw new IdentityError("subject_required");
	const claims: Claims = {
		sub,
		email: h.email.trim().toLowerCase(),
		groups: [...new Set(h.groups)],
		isOperator: h.groups.some((g) => o.operatorGroups.includes(g)),
		name: displayName(h.email.trim().toLowerCase(), h),
		preferredUsername: h.preferredUsername,
	};
	for (let attempt = 1; ; attempt++) {
		let owned = false;
		try {
			return await inTransaction(
				payload,
				(req, own) => {
					owned = own;
					return resolveIn(payload, req, claims);
				},
				o.req,
			);
		} catch (e) {
			if (owned && attempt < RESOLVE_ATTEMPTS && uniqueViolation(e)) continue;
			throw e;
		}
	}
}

interface Claims {
	sub: string;
	email: string;
	groups: string[];
	isOperator: boolean;
	/** For new and freshly bound users without a name. */
	name: string;
	preferredUsername: string | undefined;
}

async function userBy(
	payload: Payload,
	req: PayloadRequest,
	column: "idp_subject" | "email",
	value: string,
): Promise<UserRow | undefined> {
	const r = await rows<UserRow>(
		payload,
		sql`SELECT ${USER_COLS} FROM ${tbl(payload, "users")}
		     WHERE ${sql.identifier(column)} = ${value} FOR UPDATE`,
		req,
	);
	return r[0];
}

async function resolveIn(
	payload: Payload,
	req: PayloadRequest,
	c: Claims,
): Promise<SessionIdentity> {
	const now = new Date();
	const patch: Record<string, unknown> = {};

	let row = await userBy(payload, req, "idp_subject", c.sub);
	if (row) {
		// 1. Known sub.
		if (!row.active) throw new IdentityError("user_disabled");
		if (row.email !== c.email) {
			await takeEmail(payload, req, row.id, c.email);
			patch.email = c.email;
		}
	} else {
		row = await userBy(payload, req, "email", c.email);
		if (row) {
			// 2. Known email. The row may have been bound to this very sub by a
			// concurrent first login that committed while this one waited.
			if (row.idp_subject !== null && row.idp_subject !== c.sub) {
				// A new IdP account reusing the email must not get the old
				// account's teams and keys.
				throw new IdentityError(
					"identity_conflict",
					"the account is bound to another IdP identity",
				);
			}
			if (!row.active) throw new IdentityError("user_disabled");
			if (row.idp_subject === null) {
				patch.idpSubject = c.sub;
				if (!row.name) patch.name = c.name;
				Object.assign(
					patch,
					await ensurePersonalTeam(payload, req, row, c.email),
				);
			}
		} else {
			// 3. New user.
			return createUser(payload, req, c, now);
		}
	}

	// 5. Only what changed: a repeated login writes nothing.
	if (!sameSet(row.groups, c.groups)) patch.groups = c.groups;
	if (row.is_operator !== c.isOperator) patch.isOperator = c.isOperator;
	if (
		c.preferredUsername !== undefined &&
		row.preferred_username !== c.preferredUsername
	) {
		patch.preferredUsername = c.preferredUsername;
	}
	const last = toDateOrNull(row.last_login_at);
	if (!last || now.getTime() - last.getTime() >= LAST_LOGIN_INTERVAL_MS) {
		patch.lastLoginAt = now.toISOString();
	}
	if (Object.keys(patch).length > 0) {
		await payload.update({
			collection: "users",
			id: row.id,
			data: patch,
			depth: 0,
			req,
		});
	}
	return sessionOf(payload, row.id, req);
}

/**
 * The IdP changed the email of a known user: take it unless another account
 * owns it. A stub (never logged in, S8 §6.3) gives its memberships to the
 * user and is deleted; any other account is identity_conflict.
 */
async function takeEmail(
	payload: Payload,
	req: PayloadRequest,
	userId: string,
	email: string,
): Promise<void> {
	const other = await userBy(payload, req, "email", email);
	if (!other) return;
	const stub =
		other.idp_subject === null &&
		toDateOrNull(other.last_login_at) === null &&
		other.active;
	if (!stub) {
		throw new IdentityError(
			"identity_conflict",
			"the email belongs to another account",
		);
	}
	await moveMemberships(payload, req, other.id, userId);
	await payload.delete({ collection: "users", id: other.id, req });
}

/**
 * Memberships of `from` go to `to`, one id at a time: user and team of a
 * membership are fixed, so each is created for `to` (or `to`'s role is
 * raised to owner) before the old one is deleted, which keeps the last
 * owner of a team in place.
 */
export async function moveMemberships(
	payload: Payload,
	req: PayloadRequest,
	from: string,
	to: string,
): Promise<void> {
	const moving = await payload.find({
		collection: "memberships",
		where: { user: { equals: from } },
		depth: 0,
		pagination: false,
		req,
	});
	for (const m of moving.docs) {
		const team = relId(m.team) as string;
		const existing = await payload.find({
			collection: "memberships",
			where: { and: [{ user: { equals: to } }, { team: { equals: team } }] },
			depth: 0,
			limit: 1,
			req,
		});
		const mine = existing.docs[0];
		if (!mine) {
			await payload.create({
				collection: "memberships",
				data: {
					user: to,
					team,
					role: m.role,
					invitedBy: relId(m.invitedBy),
				},
				depth: 0,
				req,
			});
		} else if (m.role === "owner" && mine.role !== "owner") {
			await payload.update({
				collection: "memberships",
				id: mine.id,
				data: { role: "owner" },
				depth: 0,
				req,
			});
		}
		await payload.delete({ collection: "memberships", id: m.id, req });
	}
}

/**
 * A personal team (S8 §6.1) with the user as owner, unless they already own
 * one. Returns the user fields to set (personalTeam, defaultTeam when
 * empty).
 */
async function ensurePersonalTeam(
	payload: Payload,
	req: PayloadRequest,
	row: UserRow,
	email: string,
): Promise<Record<string, unknown>> {
	const has = await rows<{ id: string }>(
		payload,
		sql`SELECT t.id FROM ${tbl(payload, "memberships")} m
		      JOIN ${tbl(payload, "teams")} t ON t.id = m.team_id
		     WHERE m.user_id = ${row.id} AND m.role = 'owner' AND t.personal
		     LIMIT 1`,
		req,
	);
	if (has[0]) {
		return row.personal_team_id ? {} : { personalTeam: has[0].id };
	}
	const teamId = await createPersonalTeam(payload, req, row.id, email);
	return row.default_team_id === null
		? { personalTeam: teamId, defaultTeam: teamId }
		: { personalTeam: teamId };
}

async function createPersonalTeam(
	payload: Payload,
	req: PayloadRequest,
	userId: string,
	email: string,
): Promise<string> {
	const team = await payload.create({
		collection: "teams",
		data: { name: personalTeamName(email), personal: true, createdBy: userId },
		depth: 0,
		req,
	});
	await payload.create({
		collection: "memberships",
		data: { user: userId, team: team.id, role: "owner" },
		depth: 0,
		req,
	});
	return String(team.id);
}

async function createUser(
	payload: Payload,
	req: PayloadRequest,
	c: Claims,
	now: Date,
): Promise<SessionIdentity> {
	// The user row first: a concurrent first login fails here, on the
	// unique email or idpSubject, before writing anything else.
	const user = await payload.create({
		collection: "users",
		data: {
			email: c.email,
			name: c.name,
			idpSubject: c.sub,
			preferredUsername: c.preferredUsername,
			groups: c.groups,
			isOperator: c.isOperator,
			active: true,
			lastLoginAt: now.toISOString(),
		},
		depth: 0,
		req,
	});
	const userId = String(user.id);
	const teamId = await createPersonalTeam(payload, req, userId, c.email);
	await payload.update({
		collection: "users",
		id: userId,
		data: { personalTeam: teamId, defaultTeam: teamId },
		depth: 0,
		req,
	});
	return sessionOf(payload, userId, req);
}

/** SessionIdentity of a user (S8 §5.3 item 6, default team per §6.1). */
export async function sessionOf(
	payload: Payload,
	userId: string,
	req?: PayloadRequest,
): Promise<SessionIdentity> {
	const u = await rows<UserRow>(
		payload,
		sql`SELECT ${USER_COLS} FROM ${tbl(payload, "users")} WHERE id = ${userId}`,
		req,
	);
	const row = u[0];
	if (!row) throw new IdentityError("not_found");
	const user = userRecordOf(row);
	const t = await rows<{
		team_id: string;
		name: string;
		role: "owner" | "member";
		personal: boolean | null;
	}>(
		payload,
		sql`SELECT m.team_id, t.name, m.role, t.personal
		      FROM ${tbl(payload, "memberships")} m
		      JOIN ${tbl(payload, "teams")} t ON t.id = m.team_id
		     WHERE m.user_id = ${userId}
		     ORDER BY t.personal DESC NULLS LAST, t.created_at, t.id`,
		req,
	);
	const teams: TeamMembership[] = t.map((r) => ({
		teamId: r.team_id,
		name: r.name,
		role: r.role,
	}));
	const member = (id: string | null) =>
		id === null ? undefined : teams.find((m) => m.teamId === id)?.teamId;
	// The stored default while still a member, else the personal team.
	const defaultTeamId =
		member(user.defaultTeamId) ??
		member(row.personal_team_id) ??
		t.find((r) => r.personal && r.role === "owner")?.team_id ??
		teams[0]?.teamId ??
		null;
	return { user, teams, defaultTeamId, isOperator: user.isOperator };
}
