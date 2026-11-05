// UMIAK_IDENTITY_FILE loaded into Payload (S8 plan decision 5): the format
// and upsert semantics of seedIdentity of the stand-in
// (packages/auth/src/seed.ts). Upsert only: rows missing from the file are
// kept, a revoked key stays revoked, JIT bindings (idpSubject, personal
// teams) are not touched, and the email of a user who has logged in is the
// session's, not the file's. One transaction; a row is written only when a
// value differs, so loading the same file again writes and sends nothing.
//
// Teams, users and keys keep the ids of the file. The Local API cannot
// create a row with a given id, so new rows are inserted by SQL and the
// NOTIFY of the create hooks is sent here; updates and memberships go
// through the Local API (hooks notify, umiak_ssh_revoke on a deactivation).
import {
	PRESETS,
	parseIdentityFile,
	type Scope,
	type SeedResult,
} from "@umiak/auth";
import type { Payload, PayloadRequest } from "payload";
import { notify } from "../notify.ts";
import { inTransaction, rows, sql, tbl, toDate } from "./db.ts";

export async function seedPayloadIdentity(
	payload: Payload,
	yamlText: string,
): Promise<SeedResult> {
	const f = parseIdentityFile(yamlText);
	const res: SeedResult = {
		teams: f.teams.length,
		users: f.users.length,
		memberships: 0,
		apiKeys: f.apiKeys.length,
	};
	const t = (name: string) => tbl(payload, name);
	try {
		await inTransaction(payload, async (req) => {
			for (const team of f.teams) {
				const cur = await rows<{ name: string }>(
					payload,
					sql`SELECT name FROM ${t("teams")} WHERE id = ${team.id} FOR UPDATE`,
					req,
				);
				if (!cur[0]) {
					await rows(
						payload,
						sql`INSERT INTO ${t("teams")} (id, name, personal)
						    VALUES (${team.id}, ${team.name}, false)`,
						req,
					);
					await notify(req, "umiak_identity", `teams:${team.id}`);
					await notify(req, "umiak_config", `teams:${team.id}`);
				} else if (cur[0].name !== team.name) {
					await update(req, "teams", team.id, { name: team.name });
				}
			}

			for (const u of f.users) {
				const cur = await rows<{
					email: string;
					name: string | null;
					active: boolean | null;
					idp_subject: string | null;
				}>(
					payload,
					sql`SELECT email, name, active, idp_subject FROM ${t("users")}
					     WHERE id = ${u.id} FOR UPDATE`,
					req,
				);
				const row = cur[0];
				if (!row) {
					await rows(
						payload,
						sql`INSERT INTO ${t("users")} (id, email, name, active)
						    VALUES (${u.id}, ${u.email}, ${u.name ?? null}, ${u.active ?? true})`,
						req,
					);
					await notify(req, "umiak_identity", `users:${u.id}`);
				} else {
					const patch: Record<string, unknown> = {};
					// After the first login the session owns the email (S8 §5.3).
					if (row.idp_subject === null && row.email !== u.email) {
						patch.email = u.email;
					}
					if (u.name !== undefined && row.name !== u.name) patch.name = u.name;
					if (u.active !== undefined && (row.active !== false) !== u.active) {
						patch.active = u.active;
					}
					if (Object.keys(patch).length > 0) {
						await update(req, "users", u.id, patch);
					}
				}
				for (const [teamId, role] of Object.entries(u.teams)) {
					await upsertMembership(req, u.id, teamId, role);
					res.memberships++;
				}
			}

			for (const k of f.apiKeys) {
				const scopes: Scope[] = [
					...new Set(k.scopes ?? PRESETS[k.preset ?? "read-only"]),
				];
				const expiresAt = new Date(k.expiresAt);
				const cur = await rows<{
					team_id: string | null;
					name: string;
					secret_hash: string;
					prefix: string;
					last4: string;
					scopes: unknown;
					expires_at: unknown;
				}>(
					payload,
					sql`SELECT team_id, name, secret_hash, prefix, last4, scopes, expires_at
					      FROM ${t("api_keys")} WHERE id = ${k.id} FOR UPDATE`,
					req,
				);
				const row = cur[0];
				if (!row) {
					await rows(
						payload,
						sql`INSERT INTO ${t("api_keys")}
						      (id, team_id, name, kind, secret_hash, prefix, last4, scopes, created_via, expires_at)
						    VALUES (${k.id}, ${k.teamId}, ${k.name}, 'team', ${k.sha256}, ${k.prefix},
						            ${k.last4}, ${JSON.stringify(scopes)}::jsonb, 'api', ${expiresAt.toISOString()})`,
						req,
					);
					await notify(req, "umiak_identity", `api-keys:${k.id}`);
					continue;
				}
				const patch: Record<string, unknown> = {};
				if (row.team_id !== k.teamId) patch.team = k.teamId;
				if (row.name !== k.name) patch.name = k.name;
				if (row.secret_hash !== k.sha256) patch.secretHash = k.sha256;
				if (row.prefix !== k.prefix) patch.prefix = k.prefix;
				if (row.last4 !== k.last4) patch.last4 = k.last4;
				if (JSON.stringify(row.scopes) !== JSON.stringify(scopes)) {
					patch.scopes = scopes;
				}
				if (toDate(row.expires_at).getTime() !== expiresAt.getTime()) {
					patch.expiresAt = expiresAt.toISOString();
				}
				if (Object.keys(patch).length > 0) {
					await update(req, "api-keys", k.id, patch);
				}
			}
		});
	} catch (e) {
		throw new Error(`identity file: ${(e as Error).message}`, { cause: e });
	}
	return res;
}

async function update(
	req: PayloadRequest,
	collection: "teams" | "users" | "api-keys" | "memberships",
	id: string,
	data: Record<string, unknown>,
): Promise<void> {
	await req.payload.update({ collection, id, data, depth: 0, req });
}

/** One membership by (user, team); the role of an existing one is set. */
async function upsertMembership(
	req: PayloadRequest,
	userId: string,
	teamId: string,
	role: "owner" | "member",
): Promise<void> {
	const found = await req.payload.find({
		collection: "memberships",
		where: {
			and: [{ user: { equals: userId } }, { team: { equals: teamId } }],
		},
		depth: 0,
		limit: 1,
		req,
	});
	const m = found.docs[0];
	if (!m) {
		await req.payload.create({
			collection: "memberships",
			data: { user: userId, team: teamId, role },
			depth: 0,
			req,
		});
	} else if (m.role !== role) {
		await update(req, "memberships", String(m.id), { role });
	}
}
