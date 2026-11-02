// Test helpers of @umiak/payload (export "./testing"). Imports vitest through
// @umiak/auth/testing: never import this from production code.
import {
	CONTRACT_OPERATOR_GROUP,
	type IdentityContractSeeding,
	type IdentityContractSubject,
} from "@umiak/auth/testing";
import type { Payload } from "payload";
import { rows, sql, tbl } from "./identity/db.ts";
import { PayloadIdentityStore } from "./identity/store.ts";

/**
 * The direct writes of the contract suite: Local API (hooks run and
 * notify), except removeMember, a plain DELETE: the suite removes the only
 * owner of a team, which the memberships hook refuses (last_owner).
 */
export function payloadIdentitySeeding(
	payload: Payload,
): IdentityContractSeeding {
	async function membership(userId: string, teamId: string) {
		const r = await payload.find({
			collection: "memberships",
			where: {
				and: [{ user: { equals: userId } }, { team: { equals: teamId } }],
			},
			depth: 0,
			limit: 1,
		});
		return r.docs[0];
	}
	return {
		async seedUser(u) {
			const doc = await payload.create({
				collection: "users",
				data: { email: u.email, name: u.name, active: u.active ?? true },
				depth: 0,
			});
			return String(doc.id);
		},
		async seedTeam(name) {
			const doc = await payload.create({
				collection: "teams",
				data: { name },
				depth: 0,
			});
			return String(doc.id);
		},
		async addMember(userId, teamId, role) {
			const m = await membership(userId, teamId);
			if (!m) {
				await payload.create({
					collection: "memberships",
					data: { user: userId, team: teamId, role },
					depth: 0,
				});
			} else if (m.role !== role) {
				await payload.update({
					collection: "memberships",
					id: m.id,
					data: { role },
					depth: 0,
				});
			}
		},
		async removeMember(userId, teamId) {
			const m = await membership(userId, teamId);
			if (!m) return;
			await rows(
				payload,
				sql`DELETE FROM ${tbl(payload, "memberships")} WHERE id = ${String(m.id)}`,
			);
		},
		async setActive(userId, active) {
			await payload.update({
				collection: "users",
				id: userId,
				data: { active },
				depth: 0,
			});
		},
	};
}

/** PayloadIdentityStore with the seeding helpers, as the contract suite expects. */
export function payloadContractSubject(
	payload: Payload,
): IdentityContractSubject {
	const store = new PayloadIdentityStore({
		payload,
		operatorGroups: [CONTRACT_OPERATOR_GROUP],
	});
	return Object.assign(store, payloadIdentitySeeding(payload));
}
