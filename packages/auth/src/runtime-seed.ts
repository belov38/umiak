// Bootstrap inserts only: persisted API configuration and imported edits win.
import type pg from "pg";
import { inTx } from "./pg-util.ts";
import { PRESETS } from "./scopes.ts";
import { parseIdentityFile, type SeedResult } from "./seed.ts";
export async function seedRuntimeIdentity(
	pool: pg.Pool,
	text: string,
): Promise<SeedResult> {
	const file = parseIdentityFile(text);
	return inTx(pool, async (c) => {
		const result = { teams: 0, users: 0, memberships: 0, apiKeys: 0 };
		for (const t of file.teams)
			result.teams +=
				(
					await c.query(
						"INSERT INTO runtime.teams(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
						[t.id, t.name],
					)
				).rowCount ?? 0;
		for (const u of file.users) {
			result.users +=
				(
					await c.query(
						"INSERT INTO runtime.users(id,email,name,active) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING",
						[u.id, u.email, u.name ?? null, u.active ?? true],
					)
				).rowCount ?? 0;
			for (const [team, role] of Object.entries(u.teams))
				result.memberships +=
					(
						await c.query(
							"INSERT INTO runtime.memberships(user_id,team_id,role) VALUES($1,$2,$3) ON CONFLICT(user_id,team_id) DO NOTHING",
							[u.id, team, role],
						)
					).rowCount ?? 0;
		}
		for (const k of file.apiKeys)
			result.apiKeys +=
				(
					await c.query(
						`INSERT INTO runtime.api_keys(id,team_id,name,secret_hash,prefix,last4,scopes,expires_at,created_via)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'api') ON CONFLICT(id) DO NOTHING`,
						[
							k.id,
							k.teamId,
							k.name,
							k.sha256,
							k.prefix,
							k.last4,
							JSON.stringify(k.scopes ?? PRESETS[k.preset ?? "read-only"]),
							k.expiresAt,
						],
					)
				).rowCount ?? 0;
		return result;
	});
}
