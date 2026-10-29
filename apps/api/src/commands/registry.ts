// Registry of the open long connections of this process: NDJSON command
// streams, sync commands and (Task 10) PTY WebSockets (S7 §5.8, §7.10,
// S8 C9). It caps the open connections per principal and closes them:
// - when the principal stops passing its checks after NOTIFY sbx_identity
//   (key revoked, rotated or expired, member removed, user deactivated):
//   `error {code: unauthorized, retryable: false}`;
// - on shutdown (`closeAll`): `reconnect {reason: server_shutdown}`.
// A connection receives the close as a CloseFrame and writes its own final
// frame (with offsets) or WebSocket close.
import type { IdentityStore } from "@sbx/auth";
import type { Logger } from "pino";
import type {
	IdentityChange,
	IdentityListener,
} from "../auth/identity-listener.ts";
import type { AuthContext } from "../auth/principal.ts";
import { ApiError } from "../http/errors.ts";
import type { CloseFrame, ReconnectReason } from "./frames.ts";

/** Who opened a connection, as checked again on identity changes. */
export interface StreamOwner {
	/** The person; null for team keys. */
	userId: string | null;
	/** The team key; null for people. */
	apiKeyId: string | null;
	teamId: string;
	/** Secret hash of the key that opened it (a rotated secret no longer passes). */
	apiKeyHash?: string | null;
	/** An operator in a team they are not a member of (browser session). */
	operator?: boolean;
}

/** Fields that select connections for `revoke`; all given ones must match. */
export interface StreamMatch {
	userId?: string;
	apiKeyId?: string;
	teamId?: string;
}

export type StreamAbort = (frame: CloseFrame) => void;

export interface StreamRegistryOptions {
	identity: Pick<IdentityStore, "findApiKeyByHash" | "user" | "membership">;
	/** NOTIFY sbx_identity of this process. */
	events: Pick<IdentityListener, "subscribe">;
	/** Open connections per principal (SBX_API_MAX_STREAMS, default 100). */
	maxPerPrincipal: number;
	log?: Logger;
	now?: () => number;
}

interface Entry {
	owner: StreamOwner;
	abort: StreamAbort;
	closed: boolean;
}

/** The owner of an authenticated request. */
export function streamOwner(a: AuthContext): StreamOwner {
	return {
		userId: a.principal.userId,
		apiKeyId: a.principal.apiKeyId ?? null,
		teamId: a.principal.teamId,
		apiKeyHash: a.apiKey?.secretHash ?? null,
		operator: a.principal.isOperator && a.team.role === null,
	};
}

export const UNAUTHORIZED_CLOSE: CloseFrame = {
	type: "error",
	code: "unauthorized",
	message:
		"the credentials of this stream are no longer valid (key revoked or expired, membership removed or account deactivated)",
	retryable: false,
};

function principalKey(o: StreamOwner): string {
	return o.apiKeyId ?? o.userId ?? `team:${o.teamId}`;
}

function ownerKey(o: StreamOwner): string {
	return `${o.apiKeyId ?? ""}|${o.userId ?? ""}|${o.teamId}|${o.apiKeyHash ?? ""}|${o.operator ? 1 : 0}`;
}

export class StreamRegistry {
	readonly #identity: StreamRegistryOptions["identity"];
	readonly #log: Logger | undefined;
	readonly #max: number;
	readonly #now: () => number;
	readonly #entries = new Set<Entry>();
	readonly #perPrincipal = new Map<string, number>();
	readonly #unsubscribe: () => void;
	#closing = false;
	#drained: (() => void)[] = [];

	constructor(o: StreamRegistryOptions) {
		this.#identity = o.identity;
		this.#log = o.log;
		this.#max = o.maxPerPrincipal;
		this.#now = o.now ?? Date.now;
		this.#unsubscribe = o.events.subscribe((c) => {
			void this.#onChange(c);
		});
	}

	/** Open connections now. */
	get size(): number {
		return this.#entries.size;
	}

	/** Open connections of a principal (key id, else user id). */
	count(principal: string): number {
		return this.#perPrincipal.get(principal) ?? 0;
	}

	/**
	 * Registers an open connection; returns its unregister function (call it
	 * once the connection is closed, idempotent). Throws 429 `rate_limited`
	 * at the per-principal cap and 503 `server_shutting_down` after closeAll.
	 * `abort` is called at most once.
	 */
	register(owner: StreamOwner, abort: StreamAbort): () => void {
		if (this.#closing) {
			throw new ApiError(
				503,
				"server_shutting_down",
				"this api instance is shutting down; retry the request",
				{ retryable: true },
			);
		}
		const pk = principalKey(owner);
		const n = this.count(pk);
		if (n >= this.#max) {
			throw new ApiError(
				429,
				"rate_limited",
				`at most ${this.#max} streams may be open at once for this key or user; close some and retry`,
				{
					retryable: true,
					details: { limit: "streams", retryAfterSeconds: 5 },
				},
			);
		}
		const entry: Entry = { owner: { ...owner }, abort, closed: false };
		this.#entries.add(entry);
		this.#perPrincipal.set(pk, n + 1);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.#entries.delete(entry);
			const left = this.count(pk) - 1;
			if (left > 0) this.#perPrincipal.set(pk, left);
			else this.#perPrincipal.delete(pk);
			if (this.#entries.size === 0) this.#notifyDrained();
		};
	}

	/** Closes the matching connections with `error unauthorized`; returns how many. */
	revoke(match: StreamMatch, frame: CloseFrame = UNAUTHORIZED_CLOSE): number {
		let n = 0;
		for (const e of this.#entries) {
			if (match.userId !== undefined && e.owner.userId !== match.userId) {
				continue;
			}
			if (match.apiKeyId !== undefined && e.owner.apiKeyId !== match.apiKeyId) {
				continue;
			}
			if (match.teamId !== undefined && e.owner.teamId !== match.teamId) {
				continue;
			}
			if (this.#close(e, frame)) n++;
		}
		return n;
	}

	/**
	 * Shutdown: refuses new connections and closes every open one with
	 * `reconnect {reason}`. Resolves when all have unregistered or after
	 * `timeoutMs`.
	 */
	async closeAll(
		reason: ReconnectReason = "server_shutdown",
		timeoutMs = 10_000,
	): Promise<void> {
		this.#closing = true;
		for (const e of this.#entries)
			this.#close(e, { type: "reconnect", reason });
		if (this.#entries.size === 0) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref();
			this.#drained.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Stops following identity changes (the connections stay open). */
	close(): void {
		this.#unsubscribe();
	}

	#close(e: Entry, frame: CloseFrame): boolean {
		if (e.closed) return false;
		e.closed = true;
		try {
			e.abort(frame);
		} catch (err) {
			this.#log?.error(
				{ err: err instanceof Error ? err.message : String(err) },
				"stream abort failed",
			);
		}
		return true;
	}

	#notifyDrained(): void {
		const w = this.#drained;
		this.#drained = [];
		for (const fn of w) fn();
	}

	/** Entries an identity change may affect. */
	#affected(c: IdentityChange): Entry[] {
		const all = [...this.#entries].filter((e) => !e.closed);
		if (c.all) return all;
		switch (c.collection) {
			case "api-keys":
				return all.filter((e) => e.owner.apiKeyId === c.id);
			case "users":
				return all.filter((e) => e.owner.userId === c.id);
			case "memberships": {
				// '<userId>:<teamId>' in the stand-in; match the user if the
				// id has another form.
				const [userId, teamId] = c.id.split(":");
				return all.filter(
					(e) =>
						e.owner.userId === userId &&
						(teamId === undefined || e.owner.teamId === teamId),
				);
			}
			case "teams":
				return all.filter((e) => e.owner.teamId === c.id);
			case "ssh-keys":
				return [];
			default:
				return all;
		}
	}

	async #onChange(c: IdentityChange): Promise<void> {
		const byOwner = new Map<string, Entry[]>();
		for (const e of this.#affected(c)) {
			const k = ownerKey(e.owner);
			const list = byOwner.get(k) ?? [];
			list.push(e);
			byOwner.set(k, list);
		}
		await Promise.all(
			[...byOwner.values()].map(async (entries) => {
				const owner = (entries[0] as Entry).owner;
				let valid: boolean;
				try {
					valid = await this.#stillValid(owner);
				} catch (err) {
					// The store is unreachable: keep the connections, the next
					// change (or '*' after LISTEN comes back) checks again.
					this.#log?.warn(
						{ err: err instanceof Error ? err.message : String(err) },
						"stream registry: identity check failed",
					);
					return;
				}
				if (!valid) {
					for (const e of entries) this.#close(e, UNAUTHORIZED_CLOSE);
				}
			}),
		);
	}

	async #stillValid(o: StreamOwner): Promise<boolean> {
		if (o.apiKeyId !== null) {
			if (o.apiKeyHash === undefined || o.apiKeyHash === null) return true;
			const k = await this.#identity.findApiKeyByHash(o.apiKeyHash);
			return (
				k !== null &&
				k.id === o.apiKeyId &&
				k.teamId === o.teamId &&
				k.revokedAt === null &&
				k.expiresAt.getTime() > this.#now()
			);
		}
		if (o.userId !== null) {
			const u = await this.#identity.user(o.userId);
			if (u === null || !u.active) return false;
			if (o.operator && u.isOperator) return true;
			return (await this.#identity.membership(o.userId, o.teamId)) !== null;
		}
		return true;
	}
}
