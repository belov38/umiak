// Connection state of a terminal tab (S8 §9.6 Terminal), without the DOM:
// close codes of the PTY WebSocket (S7 §10.2, §23.4) and the final errors
// of the SDK's Pty as text and whether "Reconnect" can help.
import { describeError } from "@/lib/errors";

/** Scrollback asked for when (re)attaching to a terminal (S8 §9.6). */
export const PTY_TAIL_BYTES = 64 * 1024;

export type PtyPhase =
	| "connecting"
	| "attached"
	| "reconnecting"
	| "exited"
	| "failed";

/** Why the socket closed, for the "reconnecting…" bar; null: say nothing. */
export function closeCodeText(code: number): string | null {
	switch (code) {
		case 1000:
			return null;
		case 1006:
			return "connection lost";
		case 1011:
			return "server error";
		case 1012:
			return "the API is restarting";
		case 4503:
			return "the agent in the sandbox does not answer";
		default:
			return `closed with ${code}`;
	}
}

export interface PtyFailure {
	message: string;
	/** A new connection may work (the terminal may still run). */
	retry: boolean;
}

/** A final error of the Pty (close code or error frame) → text. */
export function ptyFailure(e: unknown): PtyFailure {
	const code =
		e &&
		typeof e === "object" &&
		typeof (e as { code?: unknown }).code === "string"
			? (e as { code: string }).code
			: null;
	switch (code) {
		case "sandbox_not_ready": // 4409
			return {
				message:
					"The sandbox is not ready (stopped, starting or failed). Resume it, then reconnect.",
				retry: true,
			};
		case "agent_unavailable": // 4503, retries used up
		case "network_error":
			return {
				message:
					"The terminal cannot be reached: the agent in the sandbox or the network does not answer.",
				retry: true,
			};
		case "unauthorized": // 4401
		case "token_expired":
			return {
				message:
					"Access ended: your session expired or you no longer have access to this team. Reload the page.",
				retry: false,
			};
		case "not_found": // 4404
			return { message: "This terminal does not exist anymore.", retry: false };
		case "range_not_satisfiable": // 4416
			return {
				message: "The terminal output was reset. Reconnect to see it again.",
				retry: true,
			};
		case "forbidden": // 4403
			return { message: describeError(e).message, retry: false };
		default:
			return { message: describeError(e).message, retry: true };
	}
}

/** A short title of a terminal tab. */
export function ptyTitle(c: { command: string | null; id: string }): string {
	const cmd = c.command?.trim();
	if (cmd) return cmd.length > 24 ? `${cmd.slice(0, 23)}…` : cmd;
	return `shell ${c.id.slice(-4)}`;
}

export interface TermTabState {
	id: string;
	command: string | null;
	/** Detached by the user: no connection until "Reattach". */
	detached: boolean;
}

/**
 * Tabs after a fresh list of running terminals: running ones the page does
 * not show yet are added, except the ones the user closed. A closed shell
 * may still be listed as running for a moment (SIGTERM, then SIGKILL after
 * the grace), and must not come back as a tab.
 */
export function mergeRunningTabs(
	cur: TermTabState[],
	running: { id: string; command: string | null }[],
	dismissed: ReadonlySet<string>,
): TermTabState[] {
	const known = new Set(cur.map((t) => t.id));
	const add = running
		.filter((c) => !known.has(c.id) && !dismissed.has(c.id))
		.map((c) => ({ id: c.id, command: c.command, detached: false }));
	return add.length === 0 ? cur : [...cur, ...add];
}
