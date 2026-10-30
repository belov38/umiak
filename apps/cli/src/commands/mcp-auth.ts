// The bearer of `sbx mcp` (S11 6.1, 10.1): one source for every parallel
// tool call of the process, over the CLI's Context.bearer.
// - Concurrent requests share one bearer lookup (and so one refresh when the
//   token is due; other processes are kept out by the config lock).
// - A forced refresh (the api answered `401 token_expired`) happens only if
//   the current token itself was rejected: when several calls fail with the
//   same expired token, the first one refreshes and the others take the new
//   token. The fetch wrapper tells which token a 401 was for.

import type { Bearer } from "../auth/token.ts";
import type { Fetch } from "../http.ts";

export type FetchFn = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface McpCredentials {
	/** The SDK's tokenProvider. */
	tokenProvider(o: { force: boolean }): Promise<string>;
	/** fetch for the SDK: notes a 401 to the current token. */
	fetch: FetchFn;
}

function authorizationOf(req: Request): string | null {
	return req.headers.get("authorization");
}

export function mcpCredentials(
	bearer: (force: boolean) => Promise<Bearer>,
	f: Fetch,
): McpCredentials {
	let pending: Promise<Bearer> | undefined;
	let current: string | undefined;
	let currentRejected = false;

	const lookup = (force: boolean): Promise<Bearer> => {
		const p = bearer(force).then((b) => {
			if (b.token !== current) {
				current = b.token;
				currentRejected = false;
			}
			return b;
		});
		pending = p;
		const clear = () => {
			if (pending === p) pending = undefined;
		};
		p.then(clear, clear);
		return p;
	};

	return {
		async tokenProvider({ force }) {
			if (!force) return (await (pending ?? lookup(false))).token;
			// Another call may be refreshing right now: its token is new.
			if (pending !== undefined) await pending.catch(() => {});
			if (current !== undefined && !currentRejected) return current;
			return (await (pending ?? lookup(true))).token;
		},
		async fetch(input, init) {
			// The SDK passes its own Request: hand that very object on.
			const req =
				input instanceof Request && init === undefined
					? input
					: new Request(input, init);
			const auth = authorizationOf(req);
			const res = await f(req);
			if (
				res.status === 401 &&
				current !== undefined &&
				auth === `Bearer ${current}`
			) {
				currentRejected = true;
			}
			return res;
		},
	};
}
