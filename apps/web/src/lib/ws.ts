// The browser WebSocket of the SDK (PTY, S7 §10.2) and a way for a terminal
// tab to watch its own connection (attached, closed with a code) for the
// "reconnecting…" bar. The SDK's Pty reconnects by itself; it only does not
// tell when.
import type { WebSocketFactory } from "@umiak/sdk";

export type PtySocketEvent =
	| { type: "attached" }
	| { type: "closed"; code: number };

const watchers = new Map<string, Set<(e: PtySocketEvent) => void>>();

/** `cmd_…` of a PTY connect URL, else null. */
export function ptyCommandOf(url: string): string | null {
	const m = /\/ptys\/([^/?]+)\/connect(?:\?|$)/.exec(url);
	return m?.[1] === undefined ? null : decodeURIComponent(m[1]);
}

/** Calls `cb` on every connection event of the PTY `commandId`. */
export function watchPtySocket(
	commandId: string,
	cb: (e: PtySocketEvent) => void,
): () => void {
	let set = watchers.get(commandId);
	if (set === undefined) {
		set = new Set();
		watchers.set(commandId, set);
	}
	set.add(cb);
	return () => {
		set.delete(cb);
		if (set.size === 0) watchers.delete(commandId);
	};
}

function emit(commandId: string, e: PtySocketEvent) {
	for (const cb of watchers.get(commandId) ?? []) cb(e);
}

/**
 * Subprotocols only: the SDK default passes `{protocols, headers}` (Node's
 * undici), which a browser would send as the subprotocol "[object Object]".
 * The cookie of the origin goes with the upgrade; the team is in the query
 * (S8 §9.2).
 */
export const browserWebSocket: WebSocketFactory = (url, init) => {
	const ws = new WebSocket(url, init.protocols);
	const cmd = ptyCommandOf(url);
	if (cmd !== null) {
		ws.addEventListener("message", (ev) => {
			if (typeof ev.data === "string" && ev.data.includes('"attached"')) {
				emit(cmd, { type: "attached" });
			}
		});
		ws.addEventListener("close", (ev) =>
			emit(cmd, { type: "closed", code: ev.code }),
		);
	}
	return ws;
};
