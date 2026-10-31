// IdentityStore over the Payload collections (S7 §17.3, S8 §5.3), the
// semantics of the stand-in PgIdentityStore (packages/auth/src/pg-store.ts).
// Reads are SQL over the payload schema (joins, no hooks); writes go
// through the Local API, so the collection hooks send NOTIFY sbx_identity
// and sbx_ssh_revoke in the transaction of the write. touchApiKey and
// touchSshKey are plain UPDATEs without hooks: last use does not notify.
import {
	type ApiKeyRecord,
	IdentityError,
	type IdentityStore,
	type NewApiKey,
	type NewSshKey,
	type Scope,
	type SessionHeaders,
	type SessionIdentity,
	type SshKeyRecord,
	type UserRecord,
} from "@sbx/auth";
import { type Payload, ValidationError } from "payload";
import {
	FK_VIOLATION,
	inTransaction,
	pgCode,
	rows,
	sql,
	tbl,
	toDate,
	toDateOrNull,
	uniqueViolation,
} from "./db.ts";
import { resolveSession, userRecordOf } from "./resolve-session.ts";

export interface PayloadIdentityStoreOptions {
	payload: Payload;
	/** IdP groups that make a user an operator (SBX_OPERATOR_GROUPS). */
	operatorGroups: string[];
}

interface ApiKeyRow extends Record<string, unknown> {
	id: string;
	team_id: string;
	name: string;
	secret_hash: string;
	prefix: string;
	last4: string;
	scopes: unknown;
	created_via: "api" | "cli" | "dashboard";
	created_at: unknown;
	expires_at: unknown;
	last_used_at: unknown;
	revoked_at: unknown;
	rotated_at: unknown;
	cb_id: string | null;
	cb_email: string | null;
	cb_active: boolean | null;
	cb_member: boolean;
}

interface SshKeyRow extends Record<string, unknown> {
	id: string;
	user_id: string;
	name: string;
	public_key: string;
	fingerprint: string;
	type: string;
	created_at: unknown;
	last_used_at: unknown;
}

interface UserRow extends Record<string, unknown> {
	id: string;
	email: string;
	name: string | null;
	active: boolean | null;
	is_operator: boolean | null;
	idp_subject: string | null;
	default_team_id: string | null;
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
		scopes: (Array.isArray(r.scopes) ? r.scopes : []) as Scope[],
		createdBy:
			r.cb_id === null
				? null
				: {
						id: r.cb_id,
						email: r.cb_email ?? "",
						active: r.cb_active !== false,
						member: r.cb_member === true,
					},
		createdVia: r.created_via,
		createdAt: toDate(r.created_at),
		expiresAt: toDate(r.expires_at),
		lastUsedAt: toDateOrNull(r.last_used_at),
		revokedAt: toDateOrNull(r.revoked_at),
		rotatedAt: toDateOrNull(r.rotated_at),
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
		createdAt: toDate(r.created_at),
		lastUsedAt: toDateOrNull(r.last_used_at),
	};
}

/** A relationship to a missing row: FK violation or Payload validation. */
function missingRelation(e: unknown, paths: readonly string[]): boolean {
	if (pgCode(e) === FK_VIOLATION) return true;
	return (
		e instanceof ValidationError &&
		!uniqueViolation(e) &&
		e.data.errors.some((x) => paths.includes(x.path))
	);
}

export class PayloadIdentityStore implements IdentityStore {
	readonly #payload: Payload;
	readonly #operatorGroups: string[];

	constructor(o: PayloadIdentityStoreOptions) {
		this.#payload = o.payload;
		this.#operatorGroups = [...o.operatorGroups];
	}

	resolveSession(h: SessionHeaders): Promise<SessionIdentity> {
		return resolveSession(this.#payload, h, {
			operatorGroups: this.#operatorGroups,
		});
	}

	#t(name: string) {
		return tbl(this.#payload, name);
	}

	#apiKeySelect() {
		return sql`
SELECT k.id, k.team_id, k.name, k.secret_hash, k.prefix, k.last4, k.scopes,
       k.created_via, k.created_at, k.expires_at, k.last_used_at, k.revoked_at,
       k.rotated_at, u.id AS cb_id, u.email AS cb_email, u.active AS cb_active,
       EXISTS (SELECT 1 FROM ${this.#t("memberships")} m
                WHERE m.user_id = k.created_by_id AND m.team_id = k.team_id) AS cb_member
  FROM ${this.#t("api_keys")} k
  LEFT JOIN ${this.#t("users")} u ON u.id = k.created_by_id`;
	}

	async #oneApiKey(
		where: ReturnType<typeof sql>,
	): Promise<ApiKeyRecord | null> {
		const r = await rows<ApiKeyRow>(
			this.#payload,
			sql`${this.#apiKeySelect()} WHERE ${where}`,
		);
		return r[0] ? apiKeyOf(r[0]) : null;
	}

	findApiKeyByHash(sha256Hex: string): Promise<ApiKeyRecord | null> {
		return this.#oneApiKey(sql`k.secret_hash = ${sha256Hex}`);
	}

	apiKey(id: string): Promise<ApiKeyRecord | null> {
		return this.#oneApiKey(sql`k.id = ${id}`);
	}

	async #apiKey(id: string): Promise<ApiKeyRecord> {
		const k = await this.apiKey(id);
		if (k === null) throw new IdentityError("not_found");
		return k;
	}

	async createApiKey(input: NewApiKey): Promise<ApiKeyRecord> {
		let id: string;
		try {
			const doc = await this.#payload.create({
				collection: "api-keys",
				data: {
					team: input.teamId,
					name: input.name,
					kind: "team",
					secretHash: input.secretHash,
					prefix: input.prefix,
					last4: input.last4,
					scopes: [...input.scopes],
					expiresAt: input.expiresAt.toISOString(),
					createdBy: input.createdByUserId,
					createdVia: input.createdVia,
				},
				depth: 0,
			});
			id = String(doc.id);
		} catch (e) {
			if (missingRelation(e, ["team", "createdBy"])) {
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
		await inTransaction(this.#payload, async (req) => {
			const live = await rows(
				this.#payload,
				sql`SELECT 1 FROM ${this.#t("api_keys")}
				     WHERE id = ${id} AND revoked_at IS NULL FOR UPDATE`,
				req,
			);
			if (live.length === 0) throw new IdentityError("not_found");
			await this.#payload.update({
				collection: "api-keys",
				id,
				data: { ...s, rotatedAt: new Date().toISOString() },
				depth: 0,
				req,
			});
		});
		return this.#apiKey(id);
	}

	/** Idempotent: a key revoked earlier keeps its first revocation. */
	async revokeApiKey(
		id: string,
		by: { userId?: string; apiKeyId?: string },
	): Promise<void> {
		try {
			await inTransaction(this.#payload, async (req) => {
				const k = await rows<{ revoked_at: unknown }>(
					this.#payload,
					sql`SELECT revoked_at FROM ${this.#t("api_keys")} WHERE id = ${id} FOR UPDATE`,
					req,
				);
				if (!k[0]) throw new IdentityError("not_found");
				if (k[0].revoked_at !== null) return;
				await this.#payload.update({
					collection: "api-keys",
					id,
					data: {
						revokedAt: new Date().toISOString(),
						revokedBy: by.userId ?? null,
						revokedByKey: by.apiKeyId ?? null,
					},
					depth: 0,
					req,
				});
			});
		} catch (e) {
			if (missingRelation(e, ["revokedBy", "revokedByKey"])) {
				throw new IdentityError("not_found", "unknown revoking user or key");
			}
			throw e;
		}
	}

	/** Every key of the team, revoked ones included, newest first. */
	async listApiKeys(q: { teamId: string }): Promise<ApiKeyRecord[]> {
		const r = await rows<ApiKeyRow>(
			this.#payload,
			sql`${this.#apiKeySelect()} WHERE k.team_id = ${q.teamId}
			    ORDER BY k.created_at DESC, k.id DESC`,
		);
		return r.map(apiKeyOf);
	}

	async touchApiKey(id: string): Promise<void> {
		await rows(
			this.#payload,
			sql`UPDATE ${this.#t("api_keys")} SET last_used_at = now() WHERE id = ${id}`,
		);
	}

	async listSshKeys(userId: string): Promise<SshKeyRecord[]> {
		const r = await rows<SshKeyRow>(
			this.#payload,
			sql`SELECT id, user_id, name, public_key, fingerprint, type, created_at, last_used_at
			      FROM ${this.#t("ssh_keys")} WHERE user_id = ${userId}
			     ORDER BY created_at, id`,
		);
		return r.map(sshKeyOf);
	}

	async #sshKeyWhere(
		where: ReturnType<typeof sql>,
	): Promise<SshKeyRecord | null> {
		const r = await rows<SshKeyRow>(
			this.#payload,
			sql`SELECT id, user_id, name, public_key, fingerprint, type, created_at, last_used_at
			      FROM ${this.#t("ssh_keys")} WHERE ${where}`,
		);
		return r[0] ? sshKeyOf(r[0]) : null;
	}

	async addSshKey(input: NewSshKey): Promise<SshKeyRecord> {
		let id: string;
		try {
			const doc = await this.#payload.create({
				collection: "ssh-keys",
				data: {
					user: input.userId,
					name: input.name,
					publicKey: input.publicKey,
					fingerprint: input.fingerprint,
					type: input.type,
				},
				depth: 0,
			});
			id = String(doc.id);
		} catch (e) {
			if (uniqueViolation(e)) throw new IdentityError("fingerprint_taken");
			if (missingRelation(e, ["user"])) throw new IdentityError("not_found");
			throw e;
		}
		const k = await this.#sshKeyWhere(sql`id = ${id}`);
		if (!k) throw new IdentityError("not_found");
		return k;
	}

	async removeSshKey(userId: string, id: string): Promise<void> {
		await inTransaction(this.#payload, async (req) => {
			const mine = await rows(
				this.#payload,
				sql`SELECT 1 FROM ${this.#t("ssh_keys")}
				     WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`,
				req,
			);
			if (mine.length === 0) throw new IdentityError("not_found");
			await this.#payload.delete({ collection: "ssh-keys", id, req });
		});
	}

	findSshKeyByFingerprint(fp: string): Promise<SshKeyRecord | null> {
		return this.#sshKeyWhere(sql`fingerprint = ${fp}`);
	}

	async touchSshKey(id: string): Promise<void> {
		await rows(
			this.#payload,
			sql`UPDATE ${this.#t("ssh_keys")} SET last_used_at = now() WHERE id = ${id}`,
		);
	}

	async membership(
		userId: string,
		teamId: string,
	): Promise<{ role: "owner" | "member" } | null> {
		const r = await rows<{ role: "owner" | "member" }>(
			this.#payload,
			sql`SELECT role FROM ${this.#t("memberships")}
			     WHERE user_id = ${userId} AND team_id = ${teamId}`,
		);
		return r[0] ? { role: r[0].role } : null;
	}

	async team(teamId: string): Promise<{ id: string; name: string } | null> {
		const r = await rows<{ id: string; name: string }>(
			this.#payload,
			sql`SELECT id, name FROM ${this.#t("teams")} WHERE id = ${teamId}`,
		);
		return r[0] ? { id: r[0].id, name: r[0].name } : null;
	}

	async user(userId: string): Promise<UserRecord | null> {
		const r = await rows<UserRow>(
			this.#payload,
			sql`SELECT id, email, name, active, is_operator, idp_subject, default_team_id
			      FROM ${this.#t("users")} WHERE id = ${userId}`,
		);
		return r[0] ? userRecordOf(r[0]) : null;
	}
}
