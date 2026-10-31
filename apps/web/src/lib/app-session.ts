// What the /app shell sends to the browser: public ids only (`usr_`,
// `team_`), never the UUIDs of the payload schema.
import { encodeUuid, type SessionIdentity } from "@sbx/auth";

export interface AppTeam {
	/** `team_...` */
	id: string;
	name: string;
	role: "owner" | "member";
	personal: boolean;
}

export interface AppSession {
	user: {
		/** `usr_...` */
		id: string;
		email: string;
		name: string;
	};
	teams: AppTeam[];
	/** `team_...` of the default team; "" only if the user is in no team. */
	defaultTeamId: string;
	isOperator: boolean;
}

/** `personalTeam` is the UUID from the users document (null if none). */
export function toAppSession(
	s: SessionIdentity,
	personalTeam: string | null,
): AppSession {
	const teams = s.teams
		.map(
			(t): AppTeam => ({
				id: encodeUuid("team", t.teamId),
				name: t.name,
				role: t.role,
				personal: t.teamId === personalTeam,
			}),
		)
		// Personal team first, then by name.
		.sort(
			(a, b) =>
				Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name),
		);
	const known = new Set(s.teams.map((t) => t.teamId));
	const def =
		[s.defaultTeamId, personalTeam].find(
			(id): id is string => id != null && known.has(id),
		) ?? s.teams[0]?.teamId;
	return {
		user: {
			id: encodeUuid("user", s.user.id),
			email: s.user.email,
			name: s.user.name ?? s.user.email.split("@")[0] ?? s.user.email,
		},
		teams,
		defaultTeamId: def === undefined ? "" : encodeUuid("team", def),
		isOperator: s.isOperator,
	};
}
