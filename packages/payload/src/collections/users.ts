import type { Access, AuthStrategy, CollectionConfig, Where } from "payload";
import { isOperatorReq, operatorOnly } from "../access.ts";
import { dbPool } from "../db.ts";

// Placeholder of the oauth2-proxy strategy (S8 §5.4): it authenticates nobody
// until resolveSession is wired in (S8 plan, task 3).
const oauth2ProxyPlaceholder: AuthStrategy = {
	name: "oauth2-proxy",
	authenticate: async () => ({ user: null }),
};

/**
 * Users are never deleted (their rows back `created_by` in runtime and the
 * audit), except stubs (S8 §6.3) that never logged in and have no membership.
 */
const deleteStubsOnly: Access = async ({ req, id }) => {
	if (!isOperatorReq(req)) return false;
	const pool = dbPool(req.payload);
	const schema = req.payload.db.schemaName ?? "public";
	const args: unknown[] = [];
	let byId = "";
	if (id !== undefined) {
		args.push(String(id));
		byId = "AND u.id::text = $1";
	}
	const r = await pool.query<{ id: string }>(
		`SELECT u.id FROM "${schema}".users u
		 WHERE u.last_login_at IS NULL ${byId}
		   AND NOT EXISTS (SELECT 1 FROM "${schema}".memberships m WHERE m.user_id = u.id)`,
		args,
	);
	if (r.rows.length === 0) return false;
	const where: Where = { id: { in: r.rows.map((x) => x.id) } };
	return where;
};

const lowercase = ({ value }: { value?: unknown }) =>
	typeof value === "string" ? value.trim().toLowerCase() : value;

export const Users: CollectionConfig = {
	slug: "users",
	auth: {
		disableLocalStrategy: true,
		strategies: [oauth2ProxyPlaceholder],
	},
	admin: {
		useAsTitle: "email",
		defaultColumns: ["email", "name", "active", "isOperator", "lastLoginAt"],
	},
	access: {
		admin: ({ req }) => isOperatorReq(req),
		read: operatorOnly,
		create: operatorOnly,
		update: operatorOnly,
		delete: deleteStubsOnly,
	},
	fields: [
		{
			name: "email",
			type: "email",
			required: true,
			unique: true,
			hooks: { beforeValidate: [lowercase] },
		},
		{ name: "name", type: "text" },
		{
			name: "idpSubject",
			type: "text",
			unique: true,
			admin: {
				description:
					"`sub` of the IdP; empty for stubs. Clear it to let a new IdP account take over this user.",
			},
		},
		{ name: "preferredUsername", type: "text" },
		{
			name: "groups",
			type: "json",
			admin: { readOnly: true, description: "Last groups from the IdP." },
		},
		{
			name: "isOperator",
			type: "checkbox",
			defaultValue: false,
			admin: { readOnly: true },
		},
		{ name: "active", type: "checkbox", defaultValue: true },
		{
			name: "deactivatedReason",
			type: "select",
			options: ["operator", "idp_disabled", "idp_deleted"],
		},
		{ name: "deactivatedAt", type: "date" },
		{ name: "defaultTeam", type: "relationship", relationTo: "teams" },
		{ name: "personalTeam", type: "relationship", relationTo: "teams" },
		{ name: "lastLoginAt", type: "date", admin: { readOnly: true } },
	],
};
