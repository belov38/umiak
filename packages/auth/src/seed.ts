import type pg from "pg";
import { parse } from "yaml";
import { z } from "zod";
import { inTx } from "./pg-util.ts";
import { PRESETS, SCOPES, type Scope } from "./scopes.ts";

// Identity file of the stand-in (SBX_IDENTITY_FILE, S7 plan decision 2):
// users, teams, memberships and team keys by sha256, upserted at api start.
// Upsert only: rows missing from the file are kept, a revoked key stays
// revoked, JIT bindings (idp_subject, personal teams) are not touched, and
// the email of a user who has logged in is the IdP's, not the file's.
//
//   teams:   [{id, name}]
//   users:   [{id, email, name?, active?, teams: {<teamId>: owner|member}}]
//   apiKeys: [{id, teamId, name, sha256, scopes | preset, expiresAt,
//              prefix?, last4?}]

// Any 8-4-4-4-12 hex id: hand-written files use ids like 0000...0001.
const id = z.guid();

const team = z.strictObject({ id, name: z.string().min(1).max(64) });

const user = z.strictObject({
	id,
	email: z.string().trim().toLowerCase().pipe(z.email()),
	name: z.string().min(1).optional(),
	active: z.boolean().optional(),
	teams: z.record(id, z.enum(["owner", "member"])).default({}),
});

const apiKey = z
	.strictObject({
		id,
		teamId: id,
		name: z.string().min(1).max(64),
		sha256: z
			.string()
			.regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters")
			.transform((s) => s.toLowerCase()),
		scopes: z.array(z.enum(SCOPES)).min(1).optional(),
		preset: z.enum(["read-only", "ci", "full"]).optional(),
		expiresAt: z.iso.datetime({ offset: true }),
		prefix: z.string().max(8).default(""),
		last4: z.string().max(4).default(""),
	})
	.refine((k) => (k.scopes === undefined) !== (k.preset === undefined), {
		message: "exactly one of scopes and preset is required",
	});

const identityFile = z.strictObject({
	teams: z.array(team).default([]),
	users: z.array(user).default([]),
	apiKeys: z.array(apiKey).default([]),
});

export type IdentityFile = z.infer<typeof identityFile>;

export interface SeedResult {
	teams: number;
	users: number;
	memberships: number;
	apiKeys: number;
}

/** Parses and validates an identity file; throws `invalid identity file: ...`. */
export function parseIdentityFile(yamlText: string): IdentityFile {
	let raw: unknown;
	try {
		raw = parse(yamlText);
	} catch (e) {
		throw new Error(`invalid identity file: ${(e as Error).message}`, {
			cause: e,
		});
	}
	const r = identityFile.safeParse(raw ?? {});
	if (!r.success) {
		throw new Error(`invalid identity file: ${z.prettifyError(r.error)}`);
	}
	return r.data;
}

/** Idempotent upsert of the identity file in one transaction. */
export async function seedIdentity(
	pool: pg.Pool,
	yamlText: string,
): Promise<SeedResult> {
	const f = parseIdentityFile(yamlText);
	const res: SeedResult = {
		teams: f.teams.length,
		users: f.users.length,
		memberships: 0,
		apiKeys: f.apiKeys.length,
	};
	try {
		await inTx(pool, async (c) => {
			for (const t of f.teams) {
				await c.query(
					`INSERT INTO identity.teams (id, name) VALUES ($1, $2)
					 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
					[t.id, t.name],
				);
			}
			for (const u of f.users) {
				await c.query(
					`INSERT INTO identity.users (id, email, name, active)
					 VALUES ($1, $2, $3, COALESCE($4, true))
					 ON CONFLICT (id) DO UPDATE SET
					   -- After the first login the IdP owns the email (S8 §5.3).
					   email = CASE WHEN identity.users.idp_subject IS NULL
					                THEN EXCLUDED.email ELSE identity.users.email END,
					   name = COALESCE($3, identity.users.name),
					   active = COALESCE($4, identity.users.active)`,
					[u.id, u.email, u.name ?? null, u.active ?? null],
				);
				for (const [teamId, role] of Object.entries(u.teams)) {
					await c.query(
						`INSERT INTO identity.memberships (user_id, team_id, role) VALUES ($1, $2, $3)
						 ON CONFLICT (user_id, team_id) DO UPDATE SET role = EXCLUDED.role`,
						[u.id, teamId, role],
					);
					res.memberships++;
				}
			}
			for (const k of f.apiKeys) {
				const scopes: Scope[] = [
					...new Set(k.scopes ?? PRESETS[k.preset ?? "read-only"]),
				];
				await c.query(
					`INSERT INTO identity.api_keys
					   (id, team_id, name, secret_hash, prefix, last4, scopes, created_via, expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, 'api', $8)
					 ON CONFLICT (id) DO UPDATE SET
					   team_id = EXCLUDED.team_id, name = EXCLUDED.name,
					   secret_hash = EXCLUDED.secret_hash, prefix = EXCLUDED.prefix,
					   last4 = EXCLUDED.last4, scopes = EXCLUDED.scopes,
					   expires_at = EXCLUDED.expires_at`,
					[
						k.id,
						k.teamId,
						k.name,
						k.sha256,
						k.prefix,
						k.last4,
						scopes,
						new Date(k.expiresAt),
					],
				);
			}
		});
	} catch (e) {
		throw new Error(`identity file: ${(e as Error).message}`, { cause: e });
	}
	return res;
}
