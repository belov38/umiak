// Data of /app/t/<team>/settings (S8 §9.9): team, members and, for those
// who may revoke keys (owners, operators), the open team notices (§20.1).
// Public and dashboard ids only; no UUID reaches the browser.
import { encodeUuid } from "@umiak/auth";
import { z } from "zod";
import { encodeDashboardId } from "../ids";
import { can, type TeamRole } from "../permissions";
import {
	type ActionCtx,
	type ActionResult,
	FORBIDDEN,
	fail,
	missing,
	parse,
	relationId,
} from "./core";
import { teamId } from "./schemas";

export interface TeamMemberView {
	/** `mbr_…` */
	id: string;
	/** `usr_…` */
	userId: string;
	email: string;
	name: string | null;
	role: TeamRole;
	/** A stub nobody has signed in to yet (S8 §6.3). */
	neverSignedIn: boolean;
	lastLoginAt: string | null;
	active: boolean;
}

export interface NoticeKeyView {
	/** `key_…` (DELETE /v1/api-keys/{id}) */
	id: string;
	name: string;
	prefix: string;
	revoked: boolean;
}

export interface TeamNoticeView {
	/** `ntc_…` */
	id: string;
	kind: string;
	user: { email: string; name: string | null } | null;
	createdAt: string;
	apiKeys: NoticeKeyView[];
}

export interface TeamSettingsData {
	team: { id: string; name: string; personal: boolean };
	/** Role of the caller; null for an operator outside the team. */
	myRole: TeamRole | null;
	members: TeamMemberView[];
	notices: TeamNoticeView[];
}

type Doc = Record<string, unknown> & { id: string | number };

const iso = (v: unknown): string | null =>
	v === null || v === undefined || v === ""
		? null
		: new Date(String(v)).toISOString();

const args = z.object({ teamId });

/** Members of the team or operators; others `forbidden`. */
export async function loadTeamSettingsImpl(
	ctx: ActionCtx,
	input: { teamId: string },
): Promise<ActionResult<TeamSettingsData>> {
	const a = parse(args, input);
	if ("error" in a) return a;
	const p = ctx.payload;
	const tid = a.data.teamId;
	const team = (await p.findByID({
		collection: "teams",
		id: tid,
		depth: 0,
		overrideAccess: true,
		disableErrors: true,
	})) as Doc | null;
	if (!team) return missing(ctx, "Team");

	const ms = await p.find({
		collection: "memberships",
		where: { team: { equals: tid } },
		depth: 1,
		pagination: false,
		overrideAccess: true,
	});
	const mine = ms.docs.find((m) => relationId(m.user) === ctx.session.user.id);
	const myRole = (mine?.role as TeamRole | undefined) ?? null;
	if (myRole === null && !ctx.session.isOperator) {
		return fail("forbidden", FORBIDDEN);
	}
	const personal = team.personal === true;

	const members: TeamMemberView[] = ms.docs
		.map((m): TeamMemberView | null => {
			const u = m.user as Doc | null;
			if (!u || typeof u !== "object") return null;
			const lastLoginAt = iso(u.lastLoginAt);
			return {
				id: encodeDashboardId("membership", String(m.id)),
				userId: encodeUuid("user", String(u.id)),
				email: String(u.email),
				name: typeof u.name === "string" && u.name !== "" ? u.name : null,
				role: m.role as TeamRole,
				neverSignedIn: lastLoginAt === null,
				lastLoginAt,
				active: u.active !== false,
			};
		})
		.filter((m): m is TeamMemberView => m !== null)
		.sort(
			(x, y) =>
				Number(y.role === "owner") - Number(x.role === "owner") ||
				x.email.localeCompare(y.email),
		);

	let notices: TeamNoticeView[] = [];
	if (can(ctx.session, { role: myRole, personal }, "revokeApiKeys")) {
		const ns = await p.find({
			collection: "team-notices",
			where: {
				and: [{ team: { equals: tid } }, { acknowledgedAt: { exists: false } }],
			},
			sort: "createdAt",
			depth: 1,
			pagination: false,
			overrideAccess: true,
		});
		const keyIds = ns.docs.flatMap((n) =>
			noticeKeys(n.apiKeys).map((k) => k.id),
		);
		const revoked = new Set<string>();
		if (keyIds.length > 0) {
			const ks = await p.find({
				collection: "api-keys",
				where: {
					and: [{ id: { in: keyIds } }, { revokedAt: { exists: true } }],
				},
				depth: 0,
				pagination: false,
				overrideAccess: true,
			});
			for (const k of ks.docs) revoked.add(String(k.id));
		}
		notices = ns.docs.map((n) => {
			const u = n.user as Doc | null;
			return {
				id: encodeDashboardId("teamNotice", String(n.id)),
				kind: String(n.kind),
				user:
					u && typeof u === "object"
						? {
								email: String(u.email),
								name: typeof u.name === "string" ? u.name : null,
							}
						: null,
				createdAt: iso(n.createdAt) ?? "",
				apiKeys: noticeKeys(n.apiKeys).map((k) => ({
					id: k.publicId,
					name: k.name,
					prefix: k.prefix,
					revoked: revoked.has(k.id),
				})),
			};
		});
	}

	return {
		ok: true,
		team: {
			id: encodeUuid("team", tid),
			name: String(team.name),
			personal,
		},
		myRole,
		members,
		notices,
	};
}

interface StoredNoticeKey {
	id: string;
	publicId: string;
	name: string;
	prefix: string;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `team-notices.apiKeys` as written by the IdP sync; anything else dropped,
 * a non-UUID id too (an operator's JSON in /admin): it would fail the
 * `id in [...]` query of the uuid column and the whole page with it.
 */
function noticeKeys(v: unknown): StoredNoticeKey[] {
	if (!Array.isArray(v)) return [];
	const out: StoredNoticeKey[] = [];
	for (const k of v) {
		if (!k || typeof k !== "object") continue;
		const r = k as Record<string, unknown>;
		if (typeof r.id !== "string" || !UUID_RE.test(r.id)) continue;
		let publicId: string;
		try {
			publicId =
				typeof r.publicId === "string"
					? r.publicId
					: encodeUuid("apiKey", r.id);
		} catch {
			continue;
		}
		out.push({
			id: r.id,
			publicId,
			name: typeof r.name === "string" ? r.name : "",
			prefix: typeof r.prefix === "string" ? r.prefix : "",
		});
	}
	return out;
}
