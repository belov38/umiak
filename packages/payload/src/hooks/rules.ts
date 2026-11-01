// Invariants of the collections that /admin, REST and the Local API all go
// through (S8 §6.2, §6.4, §7). Every check and write runs in the request
// transaction (req), so nested writes send their NOTIFY in it too.
import { sql } from "@payloadcms/db-postgres";
import {
	APIError,
	type CollectionBeforeChangeHook,
	type CollectionBeforeDeleteHook,
	type PayloadRequest,
	type Validate,
} from "payload";
import { txQuery } from "../notify.ts";
import { relId } from "./doc.ts";

/** req.context key: the team being deleted (its owners may go). */
const DELETING_TEAM = "umiakDeletingTeam";

function table(req: PayloadRequest, name: string) {
	const schema = req.payload.db.schemaName ?? "public";
	return sql`${sql.identifier(schema)}.${sql.identifier(name)}`;
}

// ---------------------------------------------------------------- memberships

/**
 * Refuses to drop the last owner of `teamId`. The team row is locked first
 * (FOR NO KEY UPDATE: membership inserts only take KEY SHARE), so two
 * concurrent removals of the two last owners cannot both pass.
 */
async function assertAnotherOwner(
	req: PayloadRequest,
	teamId: string,
	membershipId: string,
): Promise<void> {
	await txQuery(
		req,
		sql`SELECT 1 FROM ${table(req, "teams")} WHERE id = ${teamId} FOR NO KEY UPDATE`,
	);
	const others = await req.payload.count({
		collection: "memberships",
		where: {
			and: [
				{ team: { equals: teamId } },
				{ role: { equals: "owner" } },
				{ id: { not_equals: membershipId } },
			],
		},
		req,
	});
	if (others.totalDocs === 0) throw new APIError("last_owner", 400);
}

/**
 * user and team of a membership are fixed, with overrideAccess too: moving
 * it would leave the SSH sessions of the old (team, user) open. Replace it
 * by delete + create.
 */
export const membershipsFixedPairBeforeChange: CollectionBeforeChangeHook = ({
	data,
	originalDoc,
	operation,
}) => {
	if (operation !== "update" || !originalDoc) return data;
	for (const f of ["user", "team"] as const) {
		if (data[f] !== undefined && relId(data[f]) !== relId(originalDoc[f])) {
			throw new APIError("membership_immutable", 400);
		}
	}
	return data;
};

/**
 * A personal team (S8 §6.1) has one member: its creator as owner, added by
 * JIT right after the team. Any other membership is refused, with
 * overrideAccess too (/admin, server actions). The team row is locked as in
 * assertAnotherOwner, so two concurrent first memberships cannot both pass.
 */
export const membershipsPersonalTeamBeforeChange: CollectionBeforeChangeHook =
	async ({ data, operation, req }) => {
		if (operation !== "create") return data;
		const teamId = relId(data.team);
		if (teamId === null) return data;
		const locked = await txQuery<{
			personal: boolean | null;
			created_by_id: string | null;
		}>(
			req,
			sql`SELECT personal, created_by_id FROM ${table(req, "teams")}
			     WHERE id = ${teamId} FOR NO KEY UPDATE`,
		);
		const team = locked[0];
		if (!team?.personal) return data;
		const members = await req.payload.count({
			collection: "memberships",
			where: { team: { equals: teamId } },
			req,
		});
		if (
			members.totalDocs > 0 ||
			data.role !== "owner" ||
			team.created_by_id === null ||
			relId(data.user) !== String(team.created_by_id)
		) {
			throw new APIError("personal_team", 400);
		}
		return data;
	};

export const membershipsLastOwnerBeforeChange: CollectionBeforeChangeHook =
	async ({ data, originalDoc, operation, req }) => {
		if (operation !== "update" || !originalDoc) return data;
		if (originalDoc.role !== "owner") return data;
		const team = relId(originalDoc.team);
		const nextRole = data.role ?? originalDoc.role;
		if (team !== null && nextRole !== "owner") {
			await assertAnotherOwner(req, team, String(originalDoc.id));
		}
		return data;
	};

export const membershipsLastOwnerBeforeDelete: CollectionBeforeDeleteHook =
	async ({ id, req }) => {
		const m = await req.payload.findByID({
			collection: "memberships",
			id,
			depth: 0,
			req,
			disableErrors: true,
		});
		if (m?.role !== "owner") return;
		const team = relId(m.team);
		if (team === null || req.context[DELETING_TEAM] === team) return;
		await assertAnotherOwner(req, team, String(m.id));
	};

// ---------------------------------------------------------------- teams

/**
 * Deleting a shared team (S8 §6.4): personal teams are refused; memberships
 * and team notices are deleted, live keys revoked (kept for audit; their
 * team becomes null with the team row). Each write goes through the Local
 * API with req, so its own hooks notify in this transaction.
 */
export const teamsBeforeDelete: CollectionBeforeDeleteHook = async ({
	id,
	req,
}) => {
	const team = await req.payload.findByID({
		collection: "teams",
		id,
		depth: 0,
		req,
		disableErrors: true,
	});
	if (!team) return;
	if (team.personal) throw new APIError("personal_team", 400);
	req.context[DELETING_TEAM] = String(id);

	const byTeam = { team: { equals: id } };
	for (const collection of ["memberships", "team-notices"] as const) {
		const rows = await req.payload.find({
			collection,
			where: byTeam,
			depth: 0,
			pagination: false,
			req,
		});
		for (const row of rows.docs) {
			await req.payload.delete({ collection, id: row.id, req });
		}
	}

	const keys = await req.payload.find({
		collection: "api-keys",
		where: { and: [byTeam, { revokedAt: { exists: false } }] },
		depth: 0,
		pagination: false,
		req,
	});
	const now = new Date().toISOString();
	for (const k of keys.docs) {
		await req.payload.update({
			collection: "api-keys",
			id: k.id,
			data: { revokedAt: now },
			req,
		});
	}
};

/** personal is fixed at create: the rules above depend on it. */
export const teamsPersonalFixedBeforeChange: CollectionBeforeChangeHook = ({
	data,
	originalDoc,
	operation,
}) => {
	if (operation !== "update" || !originalDoc || data.personal === undefined) {
		return data;
	}
	if ((data.personal === true) !== (originalDoc.personal === true)) {
		throw new APIError("personal_immutable", 400);
	}
	return data;
};

// ---------------------------------------------------------------- api-keys

/** Revoking sets revokedBy to the user of the request (operator in /admin). */
export const apiKeysRevokedByBeforeChange: CollectionBeforeChangeHook = ({
	data,
	originalDoc,
	operation,
	req,
}) => {
	if (
		operation === "update" &&
		!originalDoc?.revokedAt &&
		data.revokedAt &&
		data.revokedBy == null &&
		req.user?.collection === "users"
	) {
		data.revokedBy = req.user.id;
	}
	return data;
};

/** team is nullable in the database (team deletion), required on create. */
export const requiredOnCreate: Validate = (
	value,
	{ operation, previousValue },
) =>
	value == null && (operation === "create" || previousValue != null)
		? "This field is required."
		: true;

// ---------------------------------------------------------------- users

/**
 * active true -> false without a reason (an operator in /admin) records
 * deactivatedReason "operator" and deactivatedAt; ctl-idp-sync passes its
 * own reason. false -> true clears both.
 */
export const usersDeactivationBeforeChange: CollectionBeforeChangeHook = ({
	data,
	originalDoc,
	operation,
}) => {
	if (operation !== "update" || !originalDoc || data.active === undefined) {
		return data;
	}
	const was = originalDoc.active !== false;
	const now = data.active !== false;
	if (was && !now) {
		if (data.deactivatedReason == null) data.deactivatedReason = "operator";
		if (data.deactivatedAt == null) {
			data.deactivatedAt = new Date().toISOString();
		}
	} else if (!was && now) {
		data.deactivatedReason = null;
		data.deactivatedAt = null;
	}
	return data;
};

/**
 * Users are never deleted (S8 §7), except stubs: no idpSubject, never logged
 * in, no memberships. Checked in the transaction of the delete.
 */
export const usersStubOnlyBeforeDelete: CollectionBeforeDeleteHook = async ({
	id,
	req,
}) => {
	const u = await req.payload.findByID({
		collection: "users",
		id,
		depth: 0,
		req,
		disableErrors: true,
	});
	if (!u) return;
	const memberships = await req.payload.count({
		collection: "memberships",
		where: { user: { equals: id } },
		req,
	});
	if (u.idpSubject || u.lastLoginAt || memberships.totalDocs > 0) {
		throw new APIError("user_not_stub", 400);
	}
};

// ---------------------------------------------------------------- templates and sizes

/** slug of templates and sizes is kept by template_builds and sandboxes. */
export function immutableSlug(pattern?: RegExp, hint?: string): Validate {
	return (value, { operation, previousValue }) => {
		if (typeof value !== "string" || value === "") return "slug is required";
		if (pattern && !(typeof value === "string" && pattern.test(value))) {
			return hint ?? "invalid slug";
		}
		if (
			operation === "update" &&
			previousValue !== undefined &&
			value !== previousValue
		) {
			return "slug cannot be changed";
		}
		return true;
	};
}

export const validateAllowedSizes: Validate = async (value, { req }) => {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every((s) => typeof s === "string" && s !== "")
	) {
		return "allowedSizes: a non-empty list of size slugs";
	}
	const slugs = [...new Set(value as string[])];
	if (slugs.length !== value.length) return "allowedSizes: duplicate sizes";
	const found = await req.payload.find({
		collection: "sizes",
		where: { slug: { in: slugs } },
		depth: 0,
		pagination: false,
		req,
	});
	const known = new Set(found.docs.map((d) => d.slug));
	const missing = slugs.filter((s) => !known.has(s));
	return missing.length === 0 ? true : `unknown sizes: ${missing.join(", ")}`;
};

export const validateDefaultSize: Validate = (value, { data }) => {
	const allowed = (data as { allowedSizes?: unknown }).allowedSizes;
	return Array.isArray(allowed) && allowed.includes(value)
		? true
		: "defaultSize must be one of allowedSizes";
};

/** A size named by a template or a pool target cannot be deleted. */
export const sizesInUseBeforeDelete: CollectionBeforeDeleteHook = async ({
	id,
	req,
}) => {
	const size = await req.payload.findByID({
		collection: "sizes",
		id,
		depth: 0,
		req,
		disableErrors: true,
	});
	if (!size) return;
	const slug = String(size.slug);
	const used = await txQuery(
		req,
		sql`SELECT 1 FROM ${table(req, "templates")}
		     WHERE default_size = ${slug} OR allowed_sizes @> jsonb_build_array(${slug}::text)
		    UNION ALL
		    SELECT 1 FROM ${table(req, "pool_targets")} WHERE size = ${slug}
		    LIMIT 1`,
	);
	if (used.length > 0) throw new APIError("size_in_use", 400);
};
