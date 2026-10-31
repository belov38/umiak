// The role table of S8 §6.2. Pure: the browser uses it to show or hide
// actions, the server actions check the same function after reading the
// membership inside their transaction.

export type TeamRole = "owner" | "member";

export interface PermissionSubject {
	isOperator: boolean;
}

export interface PermissionTeam {
	/** Role of the subject in the team; null when not a member. */
	role: TeamRole | null;
	personal: boolean;
}

export const TEAM_ACTIONS = [
	/** All sandboxes of the team within scopes, snapshots included. */
	"sandboxes",
	/** The subject's own SSH keys (no team needed). */
	"sshKeys",
	"viewApiKeys",
	"useEnvironments",
	/** Create, change, delete environments. */
	"manageEnvironments",
	/** Issue and rotate team API keys. */
	"issueApiKeys",
	"revokeApiKeys",
	"inviteMember",
	/** Change roles, remove members. */
	"manageMembers",
	"renameTeam",
	/** The last-owner rule is checked against the data, not here. */
	"leaveTeam",
	"deleteTeam",
	"viewQuota",
	"editQuota",
	/** Team notices (S8 §20.1): owners of the team. */
	"acknowledgeNotice",
] as const;

export type TeamAction = (typeof TEAM_ACTIONS)[number];

/** May `session` do `action` in `team` (null: no team involved)? */
export function can(
	session: PermissionSubject,
	team: PermissionTeam | null,
	action: TeamAction,
): boolean {
	if (action === "sshKeys") return true;
	if (team === null) return false;
	const owner = team.role === "owner";
	const member = team.role !== null;
	const op = session.isOperator;
	switch (action) {
		case "sandboxes":
		case "viewApiKeys":
		case "useEnvironments":
		case "viewQuota":
			return member || op;
		case "manageEnvironments":
		case "revokeApiKeys":
		case "manageMembers":
		case "renameTeam":
			return owner || op;
		case "inviteMember":
			// A personal team stays personal (§6.1).
			return (owner || op) && !team.personal;
		case "issueApiKeys":
		case "acknowledgeNotice":
			return owner;
		case "leaveTeam":
			return member && !team.personal;
		case "deleteTeam":
			// Operators in /admin only (§6.4); personal teams never.
			return op && !team.personal;
		case "editQuota":
			return op;
	}
}
