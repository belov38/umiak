// GET /v1/me (S7 §13): who the caller is, the team of the request and how
// the caller authenticated. Any valid credential; no scope needed.
import { createRoute, z } from "@hono/zod-openapi";
import { encodeUuid, SCOPES } from "@umiak/auth";
import { type AuthContext, type AuthTeam, authOf } from "../auth/principal.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
import {
	ERROR_RESPONSES,
	extensibleEnum,
	jsonResponse,
} from "../openapi/registry.ts";

const Role = extensibleEnum(["owner", "member"]).nullable().openapi({
	description:
		"Role in the team; null for team keys and operators outside the team",
});

const MeTeam = z
	.object({
		id: z.string().openapi({ example: "team_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		name: z.string(),
		role: Role,
	})
	.openapi("MeTeam");

export const MeSchema = z
	.object({
		user: z
			.object({
				id: z.string().openapi({ example: "usr_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
				email: z.string(),
				name: z.string().nullable(),
			})
			.nullable()
			.openapi({ description: "The person; null for a team API key" }),
		team: MeTeam.openapi({
			description: "Team of this request (Umiak-Team or the default team)",
		}),
		teams: z.array(MeTeam).openapi({
			description: "Teams of the person; a team key sees only its own team",
		}),
		isOperator: z.boolean().openapi({
			description: "Platform operator rights; only in a browser session",
		}),
		auth: z.object({
			kind: extensibleEnum(["session", "oidc", "team_key"]),
			apiKeyId: z.string().optional().openapi({
				description: "Team keys only",
				example: "key_01jbx2v7d3m6c8q9w0e4r5t6y7",
			}),
			scopes: z.array(extensibleEnum(SCOPES)),
			expiresAt: z.iso.datetime().optional().openapi({
				description:
					"Expiry of the key or the access token; absent for browser sessions",
			}),
			createdBy: z
				.object({
					id: z.string(),
					email: z.string(),
					active: z.boolean(),
					member: z.boolean(),
				})
				.nullable()
				.optional()
				.openapi({ description: "Team keys only: who issued the key (audit)" }),
		}),
	})
	.openapi("Me");

export type Me = z.infer<typeof MeSchema>;

const getMe = createRoute({
	method: "get",
	path: "/v1/me",
	operationId: "me.get",
	summary: "Current caller",
	description:
		"Who is calling: the person (null for a team API key), the team this request acts in, " +
		"the person's teams with roles, operator rights, and the credential (kind, scopes, expiry). " +
		"`umiak login` and `umiak whoami` call it to show the account and the default team.",
	tags: ["account"],
	responses: {
		200: jsonResponse(MeSchema, "The caller"),
		...ERROR_RESPONSES,
	},
});

function teamOf(t: AuthTeam): Me["team"] {
	return { id: encodeUuid("team", t.teamId), name: t.name, role: t.role };
}

export function toMe(a: AuthContext): Me {
	const p = a.principal;
	const key = a.apiKey;
	return {
		user:
			a.user === null
				? null
				: {
						id: encodeUuid("user", a.user.id),
						email: a.user.email,
						name: a.user.name,
					},
		team: teamOf(a.team),
		teams: a.teams.map(teamOf),
		isOperator: p.isOperator,
		auth: {
			kind: p.kind,
			...(key === null ? {} : { apiKeyId: encodeUuid("apiKey", key.id) }),
			scopes: [...p.scopes],
			...(a.tokenExpiresAt === null
				? {}
				: { expiresAt: a.tokenExpiresAt.toISOString() }),
			...(key === null
				? {}
				: {
						createdBy:
							key.createdBy === null
								? null
								: {
										...key.createdBy,
										id: encodeUuid("user", key.createdBy.id),
									},
					}),
		},
	};
}

export function registerMeRoutes(app: ApiApp, _deps: ApiDeps): void {
	app.openapi(getMe, (c) => c.json(toMe(authOf(c)), 200));
}
