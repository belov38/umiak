// Cache of resolved browser sessions in web (S8 §5.3, plan decision 8): 30 s
// by the claims (sha256 of email, sub, groups, names), flushed by every
// identity change (LISTEN sbx_identity, one connection per Payload instance)
// and whenever LISTEN is (re)established. The same behaviour as the api's
// SessionResolver (S7 §7.4). It is attached to a Payload instance, so the
// auth strategy (/admin, /cms-api) and web's own pages (/app) share it and
// never disagree about who is logged in.
import { createHash } from "node:crypto";
import type { SessionHeaders } from "@sbx/auth";
import type { Payload } from "payload";
import { ChannelListener } from "../config-listener.ts";

export const IDENTITY_CHANNEL = "sbx_identity";
export const SESSION_LISTENER_APPLICATION_NAME = "sbx-session-listener";
export const SESSION_CACHE_TTL_MS = 30_000;

/** Cached sessions before expired ones are pruned. */
const MAX_ENTRIES = 10_000;

/**
 * `sbx_identity` payloads that do not change a session: keys and SSH keys
 * are not part of it; `sandboxes:<uuid>` is an operator block for the api's
 * stream registry, not an identity change.
 */
const NOT_SESSION = new Set(["api-keys", "ssh-keys", "sandboxes"]);

/** Whether a `sbx_identity` payload (null: LISTEN re-established) must flush sessions. */
export function flushesSessions(payload: string | null): boolean {
	if (payload === null || payload === "*") return true;
	const i = payload.indexOf(":");
	const collection = i < 0 ? payload : payload.slice(0, i);
	return !NOT_SESSION.has(collection);
}

/** Cache key of a set of claims; group order and repeats do not matter. */
export function sessionCacheKey(h: SessionHeaders): string {
	const groups = [...new Set(h.groups)].sort();
	return createHash("sha256")
		.update(
			JSON.stringify([
				h.email,
				h.user ?? "",
				groups,
				h.preferredUsername ?? "",
				h.name ?? "",
			]),
		)
		.digest("hex");
}

export interface SessionCacheOptions {
	/** Default 30 s. */
	ttlMs?: number;
	now?: () => number;
}

/**
 * TTL cache with a generation: a value loaded across a flush is returned to
 * its caller but not stored (it may predate the change). Concurrent loads
 * of one key share a promise. Failures and values refused by `keep` are not
 * stored.
 */
export class SessionCache<V> {
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #entries = new Map<string, { at: number; v: V }>();
	readonly #loading = new Map<string, Promise<V>>();
	#generation = 0;

	constructor(o: SessionCacheOptions = {}) {
		this.#ttlMs = o.ttlMs ?? SESSION_CACHE_TTL_MS;
		this.#now = o.now ?? Date.now;
	}

	get size(): number {
		return this.#entries.size;
	}

	flush(): void {
		this.#generation++;
		this.#entries.clear();
		this.#loading.clear();
	}

	async load(
		key: string,
		loader: () => Promise<V>,
		keep: (v: V) => boolean = () => true,
	): Promise<V> {
		const hit = this.#entries.get(key);
		if (hit !== undefined && this.#now() - hit.at < this.#ttlMs) return hit.v;
		const pending = this.#loading.get(key);
		if (pending !== undefined) return pending;
		const gen = this.#generation;
		const at = this.#now();
		const p = loader().then((v) => {
			if (gen === this.#generation && keep(v)) this.#store(key, at, v);
			return v;
		});
		this.#loading.set(key, p);
		const forget = () => {
			if (this.#loading.get(key) === p) this.#loading.delete(key);
		};
		p.then(forget, forget);
		return p;
	}

	#store(key: string, at: number, v: V): void {
		if (this.#entries.size >= MAX_ENTRIES) {
			const now = this.#now();
			for (const [k, e] of this.#entries) {
				if (now - e.at >= this.#ttlMs) this.#entries.delete(k);
			}
			if (this.#entries.size >= MAX_ENTRIES) this.#entries.clear();
		}
		this.#entries.set(key, { at, v });
	}
}

export interface AttachSessionCacheOptions extends SessionCacheOptions {
	/** LISTEN sbx_identity on its own connection; without it only ttlMs applies. */
	listen?: { databaseUrl: string; reconnectDelayMs?: number };
	/** Listener connection errors (it reconnects by itself). */
	onListenError?: (err: unknown) => void;
}

interface Attached {
	cache: SessionCache<unknown>;
	listener: ChannelListener | null;
}

const attached = new WeakMap<Payload, Attached>();

/** The session cache of a Payload instance, if one is attached. */
export function sessionCacheOf(payload: Payload): SessionCache<unknown> | null {
	return attached.get(payload)?.cache ?? null;
}

/**
 * Attaches a session cache to a Payload instance (idempotent). With
 * `listen`, resolves once LISTEN is confirmed and rejects if the first
 * connection fails.
 */
export async function attachSessionCache(
	payload: Payload,
	o: AttachSessionCacheOptions = {},
): Promise<void> {
	if (attached.has(payload)) return;
	const cache = new SessionCache<unknown>(o);
	const listener = o.listen
		? new ChannelListener({
				databaseUrl: o.listen.databaseUrl,
				channel: IDENTITY_CHANNEL,
				applicationName: SESSION_LISTENER_APPLICATION_NAME,
				onSignal: (p) => {
					if (flushesSessions(p)) cache.flush();
				},
				...(o.listen.reconnectDelayMs === undefined
					? {}
					: { reconnectDelayMs: o.listen.reconnectDelayMs }),
				...(o.onListenError === undefined ? {} : { onError: o.onListenError }),
			})
		: null;
	attached.set(payload, { cache, listener });
	try {
		await listener?.start();
	} catch (e) {
		attached.delete(payload);
		await listener?.close();
		throw e;
	}
}

/** Drops the cache of a Payload instance and closes its listener. */
export async function detachSessionCache(payload: Payload): Promise<void> {
	const a = attached.get(payload);
	if (!a) return;
	attached.delete(payload);
	await a.listener?.close();
}
