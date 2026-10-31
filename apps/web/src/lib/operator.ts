// The operator section (S8 §9.10) without the DOM: the server guard, the
// list query of every team's sandboxes and the block body (S8 C3). Pure and
// browser-safe; the team list from Payload is built in operator-teams.ts.
import { listQuery, type SandboxState } from "./sandboxes";

export type OperatorGuard = { ok: true } | { ok: false; status: 401 | 403 };

/**
 * Only an operator's session passes (the server-resolved session, never a
 * flag sent by the browser): none → 401, anyone else → 403.
 */
export function requireOperator(
	session: { isOperator?: unknown } | null | undefined,
): OperatorGuard {
	if (session === null || session === undefined) {
		return { ok: false, status: 401 };
	}
	return session.isOperator === true
		? { ok: true }
		: { ok: false, status: 403 };
}

/** A team as the operator page shows it (`team_...`, name). */
export interface OperatorTeam {
	id: string;
	name: string;
	personal: boolean;
}

/** The team name of a sandbox, or its id when the team is unknown. */
export function teamNameOf(names: Map<string, string>, teamId: string): string {
	return names.get(teamId) ?? teamId;
}

export interface OperatorFilter {
	/** `team_...`, or "all". */
	teamId: string;
	state: SandboxState | "all";
	q: string;
}

/** Query of GET /v1/sandboxes?allTeams=true for one page. */
export function operatorListQuery(
	f: OperatorFilter,
	cursor: string | undefined,
	limit = 50,
): {
	allTeams: "true";
	teamId?: string;
	q?: string;
	state?: string;
	limit: number;
	cursor?: string;
} {
	return {
		allTeams: "true",
		...(f.teamId === "all" ? {} : { teamId: f.teamId }),
		...listQuery({ q: f.q, state: f.state, labels: {} }, cursor, limit),
	};
}

export const BLOCK_REASONS = ["operator", "abuse"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
export const MAX_BLOCK_NOTE = 500;

/** Body of POST …/block (sandbox or port), or the problem with the note. */
export function blockBody(
	reason: BlockReason,
	note: string,
):
	| { ok: true; body: { reason: BlockReason; note?: string } }
	| { ok: false; error: string } {
	const n = note.trim();
	if (n.length > MAX_BLOCK_NOTE) {
		return { ok: false, error: `At most ${MAX_BLOCK_NOTE} characters` };
	}
	return { ok: true, body: n === "" ? { reason } : { reason, note: n } };
}
