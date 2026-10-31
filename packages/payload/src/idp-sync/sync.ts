// ctl-idp-sync (S8 §20.1, offboarding variant A): platform users disabled or
// deleted in Keycloak are deactivated, users the sync deactivated and
// Keycloak enabled again are reactivated.
//
// One pass: the full Keycloak user list first (any failed page throws, no
// change is made), then the plan, then the changes. A user missing from
// the list is `idp_deleted` only after `GET /users/{id}` says 404 (the paged
// list may skip a user while it shifts). Stubs (no `idpSubject`) and
// deactivations with another reason (`operator`) are never touched. If the
// plan deactivates more than 5 users and more than 20% of the active users
// with an `idpSubject`, nothing changes and the pass reports an abort.
//
// Changes go through the Local API with a req in a transaction per user, so
// the `users` hooks send `NOTIFY sbx_identity` and `sbx_ssh_revoke` in it.
// The user row is locked and checked again before the write: a concurrent
// operator deactivation or IdP rebinding wins. A deactivated user gets a
// `team-notices` row `member_deactivated` in every team they are a member
// of, with the team's non-revoked keys they created (keys stay live, owners
// decide, S7 §7.2); an unacknowledged notice for the same (team, user) is
// not duplicated.
import { encodeUuid } from "@sbx/auth";
import type { Payload, PayloadRequest } from "payload";
import { inTransaction, rows, sql, tbl } from "../identity/db.ts";
import type { KeycloakAdminClient } from "./keycloak.ts";

export type IdpDeactivatedReason = "idp_disabled" | "idp_deleted";

/** Mass deactivation guard: abort above both limits. */
export const MASS_DEACTIVATION_MIN = 5;
export const MASS_DEACTIVATION_SHARE = 0.2;

export interface IdpSyncAbort {
	reason: "mass_deactivation";
	/** Deactivations the pass planned. */
	wouldDeactivate: number;
	/** Active users with an `idpSubject`. */
	active: number;
}

export interface IdpSyncResult {
	/** Payload user ids deactivated in this pass. */
	deactivated: string[];
	/** Payload user ids reactivated in this pass. */
	reactivated: string[];
	aborted: boolean;
	/** Set when `aborted`: what the guard saw. */
	abort?: IdpSyncAbort;
}

/** The pino-compatible subset the sync logs through. */
export interface IdpSyncLog {
	info(obj: object, msg: string): void;
	warn(obj: object, msg: string): void;
}

export interface KeycloakIdpSyncOptions {
	payload: Payload;
	keycloak: Pick<KeycloakAdminClient, "listUsers" | "userExists">;
	onAbort?(r: IdpSyncAbort): void;
	log?: IdpSyncLog;
	/** Clock of `deactivatedAt` (tests). */
	now?: () => Date;
}

/** One entry of `team-notices.apiKeys`. */
export interface NoticeApiKey {
	/** Payload uuid of the key. */
	id: string;
	/** Public id (`key_…`) for the dashboard and `/api/v1`. */
	publicId: string;
	name: string;
	prefix: string;
}

interface UserRow extends Record<string, unknown> {
	id: string;
	idp_subject: string;
	active: boolean | null;
	deactivated_reason: string | null;
}

interface Change {
	id: string;
	subject: string;
}

const IDP_REASONS = new Set(["idp_disabled", "idp_deleted"]);

const isActive = (u: { active: boolean | null }) => u.active !== false;

export class KeycloakIdpSync {
	readonly #payload: Payload;
	readonly #keycloak: KeycloakIdpSyncOptions["keycloak"];
	readonly #onAbort: KeycloakIdpSyncOptions["onAbort"];
	readonly #log: IdpSyncLog | undefined;
	readonly #now: () => Date;

	constructor(o: KeycloakIdpSyncOptions) {
		this.#payload = o.payload;
		this.#keycloak = o.keycloak;
		this.#onAbort = o.onAbort;
		this.#log = o.log;
		this.#now = o.now ?? (() => new Date());
	}

	async run(): Promise<IdpSyncResult> {
		const kc = new Map(
			(await this.#keycloak.listUsers()).map((u) => [u.id, u.enabled]),
		);
		const users = await rows<UserRow>(
			this.#payload,
			sql`SELECT id, idp_subject, active, deactivated_reason
			      FROM ${tbl(this.#payload, "users")}
			     WHERE idp_subject IS NOT NULL AND idp_subject <> ''`,
		);

		const disable: Change[] = [];
		const missing: Change[] = [];
		const enable: Change[] = [];
		for (const u of users) {
			const c = { id: String(u.id), subject: u.idp_subject };
			const enabled = kc.get(u.idp_subject);
			if (isActive(u)) {
				if (enabled === false) disable.push(c);
				else if (enabled === undefined) missing.push(c);
			} else if (
				enabled === true &&
				u.deactivated_reason !== null &&
				IDP_REASONS.has(u.deactivated_reason)
			) {
				enable.push(c);
			}
		}
		const gone: Change[] = [];
		for (const c of missing) {
			if (!(await this.#keycloak.userExists(c.subject))) gone.push(c);
		}

		const active = users.filter(isActive).length;
		const n = disable.length + gone.length;
		if (n > MASS_DEACTIVATION_MIN && n > MASS_DEACTIVATION_SHARE * active) {
			const abort: IdpSyncAbort = {
				reason: "mass_deactivation",
				wouldDeactivate: n,
				active,
			};
			// Reported, not logged: the caller alerts (worker: metrics + log.error).
			this.#onAbort?.(abort);
			return { deactivated: [], reactivated: [], aborted: true, abort };
		}

		const result: IdpSyncResult = {
			deactivated: [],
			reactivated: [],
			aborted: false,
		};
		const failures: string[] = [];
		const attempt = async (c: Change, fn: () => Promise<boolean>) => {
			try {
				return await fn();
			} catch (err) {
				failures.push(c.id);
				this.#log?.warn(
					{ user: c.id, err: err instanceof Error ? err.message : String(err) },
					"idp sync: change failed",
				);
				return false;
			}
		};
		for (const [list, reason] of [
			[disable, "idp_disabled"],
			[gone, "idp_deleted"],
		] as const) {
			for (const c of list) {
				if (await attempt(c, () => this.#deactivate(c, reason))) {
					result.deactivated.push(c.id);
				}
			}
		}
		for (const c of enable) {
			if (await attempt(c, () => this.#reactivate(c))) {
				result.reactivated.push(c.id);
			}
		}
		if (result.deactivated.length > 0 || result.reactivated.length > 0) {
			this.#log?.info(
				{ deactivated: result.deactivated, reactivated: result.reactivated },
				"idp sync applied",
			);
		}
		if (failures.length > 0) {
			throw new Error(
				`idp sync: ${failures.length} of ${n + enable.length} changes failed`,
			);
		}
		return result;
	}

	/** The user row locked in the transaction of `req`. */
	async #lock(req: PayloadRequest, id: string): Promise<UserRow | undefined> {
		const r = await rows<UserRow>(
			this.#payload,
			sql`SELECT id, idp_subject, active, deactivated_reason
			      FROM ${tbl(this.#payload, "users")} WHERE id = ${id} FOR UPDATE`,
			req,
		);
		return r[0];
	}

	async #deactivate(c: Change, reason: IdpDeactivatedReason): Promise<boolean> {
		return inTransaction(this.#payload, async (req) => {
			const cur = await this.#lock(req, c.id);
			if (!cur || cur.idp_subject !== c.subject || !isActive(cur)) return false;
			await this.#payload.update({
				collection: "users",
				id: c.id,
				data: {
					active: false,
					deactivatedReason: reason,
					deactivatedAt: this.#now().toISOString(),
				},
				depth: 0,
				req,
			});
			await this.#notify(req, c.id);
			return true;
		});
	}

	async #reactivate(c: Change): Promise<boolean> {
		return inTransaction(this.#payload, async (req) => {
			const cur = await this.#lock(req, c.id);
			if (
				!cur ||
				cur.idp_subject !== c.subject ||
				isActive(cur) ||
				cur.deactivated_reason === null ||
				!IDP_REASONS.has(cur.deactivated_reason)
			) {
				return false;
			}
			await this.#payload.update({
				collection: "users",
				id: c.id,
				data: { active: true, deactivatedReason: null, deactivatedAt: null },
				depth: 0,
				req,
			});
			return true;
		});
	}

	/** `member_deactivated` in every team of the user, once per open notice. */
	async #notify(req: PayloadRequest, userId: string): Promise<void> {
		const p = this.#payload;
		const teams = await rows<{ team_id: string }>(
			p,
			sql`SELECT team_id FROM ${tbl(p, "memberships")}
			     WHERE user_id = ${userId} ORDER BY created_at, team_id`,
			req,
		);
		for (const { team_id: team } of teams) {
			const open = await rows<{ id: string }>(
				p,
				sql`SELECT id FROM ${tbl(p, "team_notices")}
				     WHERE team_id = ${team} AND user_id = ${userId}
				       AND kind = 'member_deactivated' AND acknowledged_at IS NULL
				     LIMIT 1`,
				req,
			);
			if (open[0]) continue;
			const keys = await rows<{ id: string; name: string; prefix: string }>(
				p,
				sql`SELECT id, name, prefix FROM ${tbl(p, "api_keys")}
				     WHERE team_id = ${team} AND created_by_id = ${userId}
				       AND revoked_at IS NULL
				     ORDER BY created_at, id`,
				req,
			);
			const apiKeys: NoticeApiKey[] = keys.map((k) => ({
				id: String(k.id),
				publicId: encodeUuid("apiKey", String(k.id)),
				name: k.name,
				prefix: k.prefix,
			}));
			await p.create({
				collection: "team-notices",
				data: { team, kind: "member_deactivated", user: userId, apiKeys },
				depth: 0,
				req,
			});
		}
	}
}
