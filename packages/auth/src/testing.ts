// Test helpers of @umiak/auth (export "./testing"). Imports vitest: never import
// this from production code.
import type pg from "pg";
import {
	CONTRACT_OPERATOR_GROUP,
	type IdentityContractSeeding,
	type IdentityContractSubject,
} from "../test/contract.ts";
import { PgIdentityStore } from "./pg-store.ts";

export {
	CONTRACT_OPERATOR_GROUP,
	type IdentityContractSeeding,
	type IdentityContractSubject,
	runIdentityStoreContract,
} from "../test/contract.ts";

/** Direct writes into schema `identity` for tests (users, teams, members). */
export function pgIdentitySeeding(pool: pg.Pool): IdentityContractSeeding {
	return {
		async seedUser(u) {
			const r = await pool.query<{ id: string }>(
				`INSERT INTO identity.users (email, name, active)
				 VALUES (lower($1), $2, $3) RETURNING id`,
				[u.email, u.name ?? null, u.active ?? true],
			);
			return r.rows[0]?.id as string;
		},
		async seedTeam(name) {
			const r = await pool.query<{ id: string }>(
				"INSERT INTO identity.teams (name) VALUES ($1) RETURNING id",
				[name],
			);
			return r.rows[0]?.id as string;
		},
		async addMember(userId, teamId, role) {
			await pool.query(
				`INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, $3)
				 ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
				[userId, teamId, role],
			);
		},
		async removeMember(userId, teamId) {
			await pool.query(
				"DELETE FROM identity.memberships WHERE user_id = $1 AND team_id = $2",
				[userId, teamId],
			);
		},
		async setActive(userId, active) {
			await pool.query("UPDATE identity.users SET active = $2 WHERE id = $1", [
				userId,
				active,
			]);
		},
	};
}

/** PgIdentityStore with the seeding helpers, as the contract suite expects. */
export function pgContractSubject(pool: pg.Pool): IdentityContractSubject {
	const store = new PgIdentityStore({
		pool,
		operatorGroups: [CONTRACT_OPERATOR_GROUP],
	});
	return Object.assign(store, pgIdentitySeeding(pool));
}
