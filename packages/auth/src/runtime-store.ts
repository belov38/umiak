import type pg from "pg";
import {
	type ApiKeyRecord,
	IdentityError,
	type IdentityStore,
	type NewApiKey,
	type NewSshKey,
	type SessionHeaders,
	type SessionIdentity,
	type SshKeyRecord,
	type TeamMembership,
	type UserRecord,
} from "./identity.ts";
import { FK_VIOLATION, inTx, pgCode, UNIQUE_VIOLATION } from "./pg-util.ts";
import type { Scope } from "./scopes.ts";

// S24 SQL identity storage. Runtime triggers publish invalidation/revocation.

export interface RuntimeIdentityStoreOptions {
	pool: pg.Pool;
	/** Trusted internal session groups that make a user an operator. */
	operatorGroups: string[];
}

interface UserRow {
	id: string;
	email: string;
	name: string | null;
	active: boolean;
	is_operator: boolean;
	idp_subject: string | null;
	default_team_id: string | null;
}

interface ApiKeyRow {
	id: string;
	team_id: string;
	name: string;
	secret_hash: string;
	prefix: string;
	last4: string;
	scopes: string[];
	created_via: "api" | "cli" | "dashboard";
	created_at: Date;
	expires_at: Date;
	last_used_at: Date | null;
	revoked_at: Date | null;
	rotated_at: Date | null;
	cb_id: string | null;
	cb_email: string | null;
	cb_active: boolean | null;
	cb_member: boolean;
}

interface SshKeyRow {
	id: string;
	user_id: string;
	name: string;
	public_key: string;
	fingerprint: string;
	type: string;
	created_at: Date;
	last_used_at: Date | null;
}

const USER_COLS =
	"id, email, name, active, is_operator, idp_subject, default_team_id";

const API_KEY_SELECT = `
SELECT k.id, k.team_id, k.name, k.secret_hash, k.prefix, k.last4, k.scopes,
       k.created_via, k.created_at, k.expires_at, k.last_used_at, k.revoked_at,
       k.rotated_at, u.id AS cb_id, u.email AS cb_email, u.active AS cb_active,
       EXISTS (SELECT 1 FROM runtime.memberships m
                WHERE m.user_id = k.created_by_id AND m.team_id = k.team_id) AS cb_member
  FROM runtime.api_keys k
  LEFT JOIN runtime.users u ON u.id = k.created_by_id`;

const SSH_COLS =
	"id, user_id, name, public_key, fingerprint, type, created_at, last_used_at";

/** Attempts of resolveSession when concurrent first logins collide. */
const RESOLVE_ATTEMPTS = 3;

function userOf(r: UserRow): UserRecord {
	return {
		id: r.id,
		email: r.email,
		name: r.name,
		active: r.active,
		isOperator: r.is_operator,
		idpSubject: r.idp_subject,
		defaultTeamId: r.default_team_id,
	};
}

function apiKeyOf(r: ApiKeyRow): ApiKeyRecord {
	return {
		id: r.id,
		kind: "team",
		sandboxId: null,
		teamId: r.team_id,
		name: r.name,
		secretHash: r.secret_hash,
		prefix: r.prefix,
		last4: r.last4,
		scopes: r.scopes as Scope[],
		createdBy:
			r.cb_id === null
				? null
				: {
						id: r.cb_id,
						email: r.cb_email ?? "",
						active: r.cb_active === true,
						member: r.cb_member,
					},
		createdVia: r.created_via,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		lastUsedAt: r.last_used_at,
		revokedAt: r.revoked_at,
		rotatedAt: r.rotated_at,
	};
}

function sshKeyOf(r: SshKeyRow): SshKeyRecord {
	return {
		id: r.id,
		userId: r.user_id,
		name: r.name,
		publicKey: r.public_key,
		fingerprint: r.fingerprint,
		type: r.type,
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	};
}

/** Name of the team created at the first login. */
function personalTeamName(email: string): string {
	return `${email}'s team`;
}

export class RuntimeIdentityStore implements IdentityStore {
	readonly #pool: pg.Pool;
	readonly #operatorGroups: ReadonlySet<string>;

	constructor(opts: RuntimeIdentityStoreOptions) {
		this.#pool = opts.pool;
		this.#operatorGroups = new Set(opts.operatorGroups);
	}

	/**
	 * S8 §5.3: find by `sub`, else by email (and bind `sub`), else create the
	 * user with a personal team. `sub` is mandatory (S8 §5.3, C8): without it
	 * an email alone could resolve to, or create, an account that another IdP
	 * identity later takes over. Writes only what changed, so a repeated call
	 * with the same claims neither writes nor notifies.
	 */
	async resolveSession(h: SessionHeaders): Promise<SessionIdentity> {
		const sub = h.user?.trim() ?? "";
		if (sub === "") throw new IdentityError("subject_required");
		const email = h.email.trim().toLowerCase();
		const isOperator = h.groups.some((g) => this.#operatorGroups.has(g));
		for (let attempt = 1; ; attempt++) {
			try {
				return await inTx(this.#pool, (c) =>
					this.#resolve(c, email, sub, h, isOperator),
				);
			} catch (e) {
				// Concurrent first logins raced on the unique email or
				// idp_subject: the loser retries and finds the winner's row.
				if (pgCode(e) === UNIQUE_VIOLATION && attempt < RESOLVE_ATTEMPTS) {
					continue;
				}
				throw e;
			}
		}
	}

	async #resolve(
		c: pg.PoolClient,
		email: string,
		sub: string,
		h: SessionHeaders,
		isOperator: boolean,
	): Promise<SessionIdentity> {
		let row = (
			await c.query<UserRow>(
				`SELECT ${USER_COLS} FROM runtime.users WHERE idp_subject = $1 FOR UPDATE`,
				[sub],
			)
		).rows[0];
		let userId: string;
		if (row) {
			userId = row.id;
			if (!row.active) throw new IdentityError("user_disabled");
			if (row.email !== email) await this.#changeEmail(c, row.id, email);
		} else {
			row = (
				await c.query<UserRow>(
					`SELECT ${USER_COLS} FROM runtime.users WHERE email = $1 FOR UPDATE`,
					[email],
				)
			).rows[0];
			if (row) {
				userId = row.id;
				// The row may have been bound to this very sub by a concurrent
				// first login that committed while this one waited for the lock.
				if (row.idp_subject !== null && row.idp_subject !== sub) {
					// A new IdP account reusing the email must not get the old
					// account's teams and keys (S8 §5.3 item 2).
					throw new IdentityError(
						"identity_conflict",
						"the account is bound to another IdP identity",
					);
				}
				if (!row.active) throw new IdentityError("user_disabled");
				if (row.idp_subject === null) {
					// First login of a seeded user: bind it, add its personal team.
					await c.query(
						`UPDATE runtime.users SET idp_subject = $2, name = COALESCE(name, $3)
						  WHERE id = $1`,
						[row.id, sub, displayName(email, h)],
					);
					await this.#ensurePersonalTeam(c, row.id, email, row.default_team_id);
				}
			} else {
				userId = await this.#createUser(c, email, sub, h, isOperator);
			}
		}
		await c.query(
			"UPDATE runtime.users SET is_operator = $2 WHERE id = $1 AND is_operator <> $2",
			[userId, isOperator],
		);
		await c.query(
			`UPDATE runtime.users SET last_login_at=now(),preferred_username=$2,groups=$3
        WHERE id=$1 AND (last_login_at IS NULL OR last_login_at < now()-interval '60 seconds')`,
			[userId, h.preferredUsername ?? null, JSON.stringify(h.groups)],
		);
		return this.#session(c, userId);
	}

	// Preserve S8's placeholder merge; a bound/inactive account is never taken over.
	async #changeEmail(
		c: pg.PoolClient,
		userId: string,
		email: string,
	): Promise<void> {
		const other = await c.query<{
			id: string;
			idp_subject: string | null;
			last_login_at: Date | null;
			active: boolean;
		}>(
			"SELECT id,idp_subject,last_login_at,active FROM runtime.users WHERE email = $1 FOR UPDATE",
			[email],
		);
		const stub = other.rows[0];
		if (
			stub &&
			(stub.idp_subject !== null || stub.last_login_at !== null || !stub.active)
		) {
			throw new IdentityError(
				"identity_conflict",
				"the email belongs to another account",
			);
		}
		if (stub) {
			await c.query(
				`INSERT INTO runtime.memberships(user_id,team_id,role,invited_by_id)
          SELECT $2,team_id,role,invited_by_id FROM runtime.memberships WHERE user_id=$1
          ON CONFLICT(user_id,team_id) DO UPDATE SET role=
            CASE WHEN runtime.memberships.role='owner' OR EXCLUDED.role='owner' THEN 'owner' ELSE 'member' END`,
				[stub.id, userId],
			);
			await c.query("DELETE FROM runtime.memberships WHERE user_id=$1", [
				stub.id,
			]);
			await c.query("DELETE FROM runtime.users WHERE id=$1", [stub.id]);
		}
		await c.query("UPDATE runtime.users SET email = $2 WHERE id = $1", [
			userId,
			email,
		]);
	}

	async #createUser(
		c: pg.PoolClient,
		email: string,
		sub: string,
		h: SessionHeaders,
		isOperator: boolean,
	): Promise<string> {
		const team = await c.query<{ id: string }>(
			"INSERT INTO runtime.teams (name, personal) VALUES ($1, true) RETURNING id",
			[personalTeamName(email)],
		);
		const teamId = team.rows[0]?.id as string;
		const created = await c.query<{ id: string }>(
			`INSERT INTO runtime.users (email, name, idp_subject, is_operator, default_team_id, personal_team_id)
			 VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
			[email, displayName(email, h), sub, isOperator, teamId],
		);
		const userId = created.rows[0]?.id as string;
		await c.query("UPDATE runtime.teams SET created_by_id=$2 WHERE id=$1", [
			teamId,
			userId,
		]);
		await c.query(
			"INSERT INTO runtime.memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')",
			[userId, teamId],
		);
		return userId;
	}

	async #ensurePersonalTeam(
		c: pg.PoolClient,
		userId: string,
		email: string,
		defaultTeamId: string | null,
	): Promise<void> {
		const has = await c.query(
			`SELECT 1 FROM runtime.memberships m JOIN runtime.teams t ON t.id = m.team_id
			  WHERE m.user_id = $1 AND m.role = 'owner' AND t.personal`,
			[userId],
		);
		if (has.rowCount) return;
		const team = await c.query<{ id: string }>(
			"INSERT INTO runtime.teams (name, personal) VALUES ($1, true) RETURNING id",
			[personalTeamName(email)],
		);
		const teamId = team.rows[0]?.id as string;
		await c.query(
			"INSERT INTO runtime.memberships (user_id, team_id, role) VALUES ($1, $2, 'owner')",
			[userId, teamId],
		);
		await c.query("UPDATE runtime.teams SET created_by_id=$2 WHERE id=$1", [
			teamId,
			userId,
		]);
		await c.query("UPDATE runtime.users SET personal_team_id=$2 WHERE id=$1", [
			userId,
			teamId,
		]);
		if (defaultTeamId === null) {
			await c.query(
				"UPDATE runtime.users SET default_team_id = $2 WHERE id = $1",
				[userId, teamId],
			);
		}
	}

	async #session(c: pg.PoolClient, userId: string): Promise<SessionIdentity> {
		const u = await c.query<UserRow>(
			`SELECT ${USER_COLS} FROM runtime.users WHERE id = $1`,
			[userId],
		);
		const user = userOf(u.rows[0] as UserRow);
		const t = await c.query<{
			team_id: string;
			name: string;
			role: "owner" | "member";
			personal: boolean;
		}>(
			`SELECT m.team_id, t.name, m.role, t.personal
			   FROM runtime.memberships m JOIN runtime.teams t ON t.id = m.team_id
			  WHERE m.user_id = $1
			  ORDER BY t.personal DESC, t.created_at, t.id`,
			[userId],
		);
		const teams: TeamMembership[] = t.rows.map((r) => ({
			teamId: r.team_id,
			name: r.name,
			role: r.role,
		}));
		// The stored default while still a member, else the personal team (S8 §6.1).
		const personal = t.rows.find((r) => r.personal && r.role === "owner");
		const defaultTeamId =
			teams.find((m) => m.teamId === user.defaultTeamId)?.teamId ??
			personal?.team_id ??
			teams[0]?.teamId ??
			null;
		return { user, teams, defaultTeamId, isOperator: user.isOperator };
	}

	async findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.secret_hash = $1 AND k.team_id IS NOT NULL`,
			[sha256Hex],
		);
		return r.rows[0] ? apiKeyOf(r.rows[0]) : null;
	}

	async apiKey(id: string): Promise<ApiKeyRecord | null> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.id = $1 AND k.team_id IS NOT NULL`,
			[id],
		);
		return r.rows[0] ? apiKeyOf(r.rows[0]) : null;
	}

	async #apiKey(id: string): Promise<ApiKeyRecord> {
		const k = await this.apiKey(id);
		if (k === null) throw new IdentityError("not_found");
		return k;
	}

	async createApiKey(input: NewApiKey): Promise<ApiKeyRecord> {
		let id: string;
		try {
			const r = await this.#pool.query<{ id: string }>(
				`INSERT INTO runtime.api_keys
				   (team_id, name, secret_hash, prefix, last4, scopes, created_by_id, created_via, expires_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
				[
					input.teamId,
					input.name,
					input.secretHash,
					input.prefix,
					input.last4,
					JSON.stringify(input.scopes),
					input.createdByUserId,
					input.createdVia,
					input.expiresAt,
				],
			);
			id = r.rows[0]?.id as string;
		} catch (e) {
			if (pgCode(e) === FK_VIOLATION) {
				throw new IdentityError("not_found", "unknown team or creator");
			}
			throw e;
		}
		return this.#apiKey(id);
	}

	/** A revoked or unknown key is not_found. */
	async rotateApiKey(
		id: string,
		s: { secretHash: string; prefix: string; last4: string },
	): Promise<ApiKeyRecord> {
		const r = await this.#pool.query(
			`UPDATE runtime.api_keys
			    SET secret_hash = $2, prefix = $3, last4 = $4, rotated_at = now()
			  WHERE id = $1 AND revoked_at IS NULL`,
			[id, s.secretHash, s.prefix, s.last4],
		);
		if (!r.rowCount) throw new IdentityError("not_found");
		return this.#apiKey(id);
	}

	/** Idempotent: a key revoked earlier keeps its first revocation. */
	async revokeApiKey(
		id: string,
		by: { userId?: string; apiKeyId?: string },
	): Promise<void> {
		let n: number | null;
		try {
			n = (
				await this.#pool.query(
					`UPDATE runtime.api_keys
					    SET revoked_at = now(), revoked_by_id = $2, revoked_by_key_id = $3
					  WHERE id = $1 AND revoked_at IS NULL`,
					[id, by.userId ?? null, by.apiKeyId ?? null],
				)
			).rowCount;
		} catch (e) {
			if (pgCode(e) === FK_VIOLATION) {
				throw new IdentityError("not_found", "unknown revoking user or key");
			}
			throw e;
		}
		if (n) return;
		const exists = await this.#pool.query(
			"SELECT 1 FROM runtime.api_keys WHERE id = $1",
			[id],
		);
		if (!exists.rowCount) throw new IdentityError("not_found");
	}

	/** Every key of the team, revoked ones included, newest first. */
	async listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]> {
		const r = await this.#pool.query<ApiKeyRow>(
			`${API_KEY_SELECT} WHERE k.team_id = $1 ORDER BY k.created_at DESC, k.id DESC`,
			[q.teamId],
		);
		return r.rows.map(apiKeyOf);
	}

	async touchApiKey(id: string): Promise<void> {
		await this.#pool.query(
			"UPDATE runtime.api_keys SET last_used_at = now() WHERE id = $1",
			[id],
		);
	}

	async listSshKeys(userId: string): Promise<SshKeyRecord[]> {
		const r = await this.#pool.query<SshKeyRow>(
			`SELECT ${SSH_COLS} FROM runtime.ssh_keys WHERE user_id = $1 ORDER BY created_at, id`,
			[userId],
		);
		return r.rows.map(sshKeyOf);
	}

	async addSshKey(input: NewSshKey): Promise<SshKeyRecord> {
		try {
			const r = await this.#pool.query<SshKeyRow>(
				`INSERT INTO runtime.ssh_keys (user_id, name, public_key, fingerprint, type)
				 VALUES ($1, $2, $3, $4, $5) RETURNING ${SSH_COLS}`,
				[
					input.userId,
					input.name,
					input.publicKey,
					input.fingerprint,
					input.type,
				],
			);
			return sshKeyOf(r.rows[0] as SshKeyRow);
		} catch (e) {
			const code = pgCode(e);
			if (code === UNIQUE_VIOLATION)
				throw new IdentityError("fingerprint_taken");
			if (code === FK_VIOLATION) throw new IdentityError("not_found");
			throw e;
		}
	}

	async removeSshKey(userId: string, id: string): Promise<void> {
		const r = await this.#pool.query(
			"DELETE FROM runtime.ssh_keys WHERE id = $1 AND user_id = $2",
			[id, userId],
		);
		if (!r.rowCount) throw new IdentityError("not_found");
	}

	async findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null> {
		const r = await this.#pool.query<SshKeyRow>(
			`SELECT ${SSH_COLS} FROM runtime.ssh_keys WHERE fingerprint = $1`,
			[fp],
		);
		return r.rows[0] ? sshKeyOf(r.rows[0]) : null;
	}

	async touchSshKey(id: string): Promise<void> {
		await this.#pool.query(
			"UPDATE runtime.ssh_keys SET last_used_at = now() WHERE id = $1",
			[id],
		);
	}

	async membership(
		userId: string,
		teamId: string,
	): Promise<{ role: "owner" | "member" } | null> {
		const r = await this.#pool.query<{ role: "owner" | "member" }>(
			"SELECT role FROM runtime.memberships WHERE user_id = $1 AND team_id = $2",
			[userId, teamId],
		);
		return r.rows[0] ? { role: r.rows[0].role } : null;
	}

	async team(teamId: string): Promise<{ id: string; name: string } | null> {
		const r = await this.#pool.query<{ id: string; name: string }>(
			"SELECT id, name FROM runtime.teams WHERE id = $1",
			[teamId],
		);
		return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].name } : null;
	}

	async user(userId: string): Promise<UserRecord | null> {
		const r = await this.#pool.query<UserRow>(
			`SELECT ${USER_COLS} FROM runtime.users WHERE id = $1`,
			[userId],
		);
		return r.rows[0] ? userOf(r.rows[0]) : null;
	}
}

// S8 §5.3: name, else preferred username, else the local part of the email.
function displayName(email: string, h: SessionHeaders): string {
	return h.name ?? h.preferredUsername ?? email.split("@")[0] ?? email;
}
