import { decodeUuid, encodeUuid } from "@umiak/auth";
import { withTx } from "@umiak/db";
import type pg from "pg";
import type { AuthContext } from "../auth/principal.ts";
import { ApiError, notFoundError, validationError } from "../http/errors.ts";
import * as S from "./schemas.ts";

type Doc = Record<string, unknown>;
const conflict = (message: string) =>
	new ApiError(409, "configuration_conflict", message);
const invalid = (message: string) => validationError([{ path: "", message }]);
export function teamUuid(value: string) {
	const id = decodeUuid("team", value);
	if (!id) throw invalid("Invalid team id");
	return id;
}
function view(row: Doc): Doc {
	const out: Doc = {};
	for (const [key, value] of Object.entries(row)) {
		const camel = (s: string) =>
			s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
		const group = [
			"new_shared_team_quota_",
			"default_quota_",
			"rate_limits_",
			"quota_",
		].find((p) => key.startsWith(p));
		if (group) {
			const name = camel(group.slice(0, -1));
			out[name] ??= {};
			(out[name] as Doc)[camel(key.slice(group.length))] = value;
		} else out[camel(key)] = value;
	}
	return out;
}
const tables = {
	templates: "templates",
	sizes: "sizes",
	"platform-defaults": "platform_defaults",
} as const;
export type Collection = keyof typeof tables;
export async function list(pool: pg.Pool, collection: Collection) {
	return (
		await pool.query(
			`SELECT to_jsonb(t) AS doc FROM runtime.${tables[collection]} t ORDER BY ${collection === "templates" || collection === "sizes" ? "sort_order,slug" : "id"}`,
		)
	).rows.map((r) => view(r.doc));
}
export async function defaults(pool: pg.Pool) {
	const doc = (await list(pool, "platform-defaults"))[0] ?? {};
	return S.Defaults.parse(
		Object.fromEntries(
			Object.keys(S.Defaults.shape).map((key) => [key, doc[key]]),
		),
	);
}
export async function teams(pool: pg.Pool, userId: string) {
	const result = await pool.query(
		`SELECT to_jsonb(t) AS doc,m.role FROM runtime.teams t LEFT JOIN runtime.memberships m ON m.team_id=t.id AND m.user_id=$1 ORDER BY t.personal DESC,t.name,t.id`,
		[userId],
	);
	return result.rows.map((r) =>
		S.Team.parse({
			...view(r.doc),
			id: encodeUuid("team", r.doc.id),
			role: r.role ?? null,
			personal: r.doc.personal === true,
		}),
	);
}
export async function session(pool: pg.Pool, auth: AuthContext) {
	if (!auth.user)
		throw new ApiError(403, "forbidden", "Owner session required");
	const user = auth.user;
	const all = await teams(pool, user.id);
	const row = (
		await pool.query(
			"SELECT default_team_id,personal_team_id FROM runtime.users WHERE id=$1",
			[user.id],
		)
	).rows[0];
	const selected =
		[row?.default_team_id, row?.personal_team_id, auth.principal.teamId]
			.map((id) => (id ? encodeUuid("team", id) : ""))
			.find((id) => all.some((t) => t.id === id && t.role !== null)) ??
		all.find((t) => t.role !== null)?.id ??
		"";
	return {
		user: {
			id: encodeUuid("user", user.id),
			email: user.email,
			name: user.name ?? user.email.split("@")[0] ?? user.email,
		},
		teams: all,
		defaultTeamId: selected,
		isOperator: true,
	};
}
export async function account(pool: pg.Pool, userId: string, publicId: string) {
	const id = teamUuid(publicId);
	return withTx(pool, async ({ client: c }) => {
		await c.query("SELECT id FROM runtime.users WHERE id=$1 FOR UPDATE", [
			userId,
		]);
		if (
			!(
				await c.query(
					"SELECT 1 FROM runtime.memberships WHERE user_id=$1 AND team_id=$2",
					[userId, id],
				)
			).rowCount
		)
			throw invalid("Default workspace must be one of your memberships");
		await c.query("UPDATE runtime.users SET default_team_id=$2 WHERE id=$1", [
			userId,
			id,
		]);
		return { ok: true as const };
	});
}
export async function createTeam(pool: pg.Pool, userId: string, name: string) {
	return withTx(pool, async ({ client: c }) => {
		await c.query("SELECT id FROM runtime.users WHERE id=$1 FOR UPDATE", [
			userId,
		]);
		const g = (await c.query("SELECT * FROM runtime.platform_defaults"))
			.rows[0];
		const count = Number(
			(
				await c.query(
					"SELECT count(*) FROM runtime.teams t JOIN runtime.memberships m ON m.team_id=t.id WHERE m.user_id=$1 AND m.role='owner' AND NOT t.personal",
					[userId],
				)
			).rows[0].count,
		);
		if (count >= Number(g.max_owned_teams_per_user ?? 3))
			throw conflict("Workspace limit reached");
		const team = (
			await c.query(
				`INSERT INTO runtime.teams(name,created_by_id,quota_max_active_sandboxes,quota_max_ram_mb,quota_max_saved_snapshots) VALUES($1,$2,$3,$4,$5) RETURNING id`,
				[
					name,
					userId,
					g.new_shared_team_quota_max_active_sandboxes,
					g.new_shared_team_quota_max_ram_mb,
					g.new_shared_team_quota_max_saved_snapshots,
				],
			)
		).rows[0].id;
		await c.query(
			"INSERT INTO runtime.memberships(user_id,team_id,role) VALUES($1,$2,'owner')",
			[userId, team],
		);
		return {
			id: encodeUuid("team", team),
			name,
			personal: false,
			role: "owner",
			quota: {
				maxActiveSandboxes:
					g.new_shared_team_quota_max_active_sandboxes == null
						? null
						: Number(g.new_shared_team_quota_max_active_sandboxes),
				maxRamMb:
					g.new_shared_team_quota_max_ram_mb == null
						? null
						: Number(g.new_shared_team_quota_max_ram_mb),
				maxSavedSnapshots:
					g.new_shared_team_quota_max_saved_snapshots == null
						? null
						: Number(g.new_shared_team_quota_max_saved_snapshots),
			},
		};
	});
}
function flatten(input: Doc): Doc {
	const out: Doc = {};
	const snake = (s: string) =>
		s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
	for (const [key, value] of Object.entries(input)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			for (const [k, v] of Object.entries(value))
				out[`${snake(key)}_${snake(k)}`] = v;
		} else
			out[snake(key)] = Array.isArray(value) ? JSON.stringify(value) : value;
	}
	return out;
}
async function patch(
	c: pg.PoolClient,
	table: string,
	where: string,
	id: string,
	input: Doc,
) {
	const entries = Object.entries(flatten(input));
	if (!entries.length) return;
	await c.query(
		`UPDATE runtime.${table} SET ${entries.map(([k], i) => `${k}=$${i + 2}`).join(",")},updated_at=now() WHERE ${where}=$1`,
		[id, ...entries.map(([, v]) => v)],
	);
}
export async function updateTeam(pool: pg.Pool, id: string, input: Doc) {
	return withTx(pool, async ({ client: c }) => {
		if (
			!(
				await c.query("SELECT id FROM runtime.teams WHERE id=$1 FOR UPDATE", [
					id,
				])
			).rowCount
		)
			throw notFoundError("workspace");
		await patch(c, "teams", "id", id, input);
		return { ok: true as const };
	});
}
export async function deleteTeam(pool: pg.Pool, id: string) {
	return withTx(pool, async ({ client: c }) => {
		await c.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('team:' || $1::text,0))",
			[id],
		);
		const team = (
			await c.query(
				"SELECT personal FROM runtime.teams WHERE id=$1 FOR UPDATE",
				[id],
			)
		).rows[0];
		if (!team) throw notFoundError("workspace");
		if (team.personal) throw conflict("A personal workspace cannot be deleted");
		const busy = await c.query(
			`SELECT 1 FROM runtime.sandboxes WHERE team_id=$1 AND state<>'deleted' UNION ALL SELECT 1 FROM runtime.snapshots WHERE team_id=$1 AND state<>'deleted' UNION ALL SELECT 1 FROM runtime.environments WHERE team_id=$1 LIMIT 1`,
			[id],
		);
		if (busy.rowCount)
			throw conflict(
				"Delete this workspace's sandboxes, snapshots and environments first",
			);
		await c.query(
			"UPDATE runtime.users SET default_team_id=personal_team_id WHERE default_team_id=$1",
			[id],
		);
		await c.query(
			"UPDATE runtime.api_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE team_id=$1",
			[id],
		);
		await c.query("DELETE FROM runtime.memberships WHERE team_id=$1", [id]);
		await c.query("DELETE FROM runtime.teams WHERE id=$1", [id]);
		return { ok: true as const };
	});
}
export async function mutateCatalog(
	pool: pg.Pool,
	collection: "templates" | "sizes",
	slug: string,
	input: Doc,
	create = false,
	remove = false,
) {
	return withTx(pool, async ({ client: c }) => {
		await c.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('configuration-catalog',0))",
		);
		const current = (
			await c.query(
				`SELECT to_jsonb(t) AS doc FROM runtime.${collection} t WHERE slug=$1 FOR UPDATE`,
				[slug],
			)
		).rows[0]?.doc;
		if (!create && !current) throw notFoundError(collection);
		if (remove) {
			const referenced =
				collection === "sizes"
					? await c.query(
							"SELECT 1 FROM runtime.templates WHERE default_size=$1 OR allowed_sizes ? $1 LIMIT 1",
							[slug],
						)
					: await c.query(
							"SELECT 1 FROM runtime.sandboxes WHERE template_slug=$1 AND state<>'deleted' UNION ALL SELECT 1 FROM runtime.template_builds WHERE template_slug=$1 AND status<>'retired' UNION ALL SELECT 1 FROM runtime.platform_defaults WHERE default_template=$1 LIMIT 1",
							[slug],
						);
			if (referenced.rowCount)
				throw conflict("Configuration is still referenced");
			await c.query(`DELETE FROM runtime.${collection} WHERE slug=$1`, [slug]);
			return { ok: true as const };
		}
		if (collection === "templates") {
			const merged = { ...(current ? view(current) : {}), ...input };
			const allowed = merged.allowedSizes as string[];
			if (!allowed.includes(String(merged.defaultSize)))
				throw invalid("Default size must be allowed");
			if (new Set(allowed).size !== allowed.length)
				throw invalid("Duplicate allowed size");
			if (
				merged.enabled === false &&
				(
					await c.query(
						"SELECT 1 FROM runtime.platform_defaults WHERE default_template=$1",
						[slug],
					)
				).rowCount
			)
				throw conflict("The default template cannot be disabled");
			const known = (
				await c.query(
					"SELECT slug FROM runtime.sizes WHERE slug=ANY($1::text[])",
					[allowed],
				)
			).rows;
			if (known.length !== new Set(allowed).size) throw invalid("Unknown size");
		}
		if (create) {
			const entries = Object.entries(flatten(input));
			await c.query(
				`INSERT INTO runtime.${collection}(${entries.map(([k]) => k).join(",")}) VALUES(${entries.map((_, i) => `$${i + 1}`).join(",")})`,
				entries.map(([, v]) => v),
			);
		} else await patch(c, collection, "slug", slug, input);
		return { ok: true as const };
	});
}
export async function setDefaults(pool: pg.Pool, input: Doc) {
	return withTx(pool, async ({ client: c }) => {
		await c.query(
			"SELECT pg_advisory_xact_lock(hashtextextended('configuration-catalog',0))",
		);
		if (
			!(
				await c.query(
					"SELECT 1 FROM runtime.templates WHERE slug=$1 AND enabled",
					[input.defaultTemplate],
				)
			).rowCount
		)
			throw invalid("Unknown or disabled default template");
		if (
			input.ttlSeconds != null &&
			Number(input.ttlSeconds) > Number(input.maxTtlSeconds)
		)
			throw invalid("TTL exceeds maximum TTL");
		const id = (
			await c.query("SELECT id FROM runtime.platform_defaults FOR UPDATE")
		).rows[0].id;
		await patch(c, "platform_defaults", "id", id, input);
		return { ok: true as const };
	});
}
