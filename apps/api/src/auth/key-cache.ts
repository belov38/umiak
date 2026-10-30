// In-process cache of team API keys by secret hash (S7 §7.2): positive
// entries for 30 s, negative (unknown hash) for 5 s, flushed by NOTIFY
// sbx_identity 'api-keys:<id>' and '*'. A revoked key stops working on every
// pod within the positive TTL at worst, usually at once.
import type { ApiKeyRecord, IdentityStore } from "@sbx/auth";
import type { Logger } from "pino";
import type { IdentityListener } from "./identity-listener.ts";

export interface CachedKey {
	key: ApiKeyRecord;
	teamName: string;
}

export interface KeyCacheOptions {
	positiveTtlMs?: number;
	negativeTtlMs?: number;
	/** `touchApiKey` at most this often per key (default 60 s). */
	touchIntervalMs?: number;
	now?: () => number;
	log?: Logger;
}

/**
 * Entries kept before expired ones are pruned. Anyone can compute a
 * well-formed key (the CRC is public), so negative entries are bounded.
 */
const MAX_ENTRIES = 10_000;

interface Entry {
	at: number;
	value: CachedKey | null;
}

export class KeyCache {
	readonly #identity: IdentityStore;
	readonly #positiveTtlMs: number;
	readonly #negativeTtlMs: number;
	readonly #touchIntervalMs: number;
	readonly #now: () => number;
	readonly #log: Logger | undefined;
	readonly #byHash = new Map<string, Entry>();
	/** Key id -> hash of its positive entry. */
	readonly #hashOf = new Map<string, string>();
	readonly #inflight = new Map<string, Promise<CachedKey | null>>();
	/** Last `touchApiKey` per key id (ms). */
	readonly #touched = new Map<string, number>();
	#generation = 0;

	constructor(
		identity: IdentityStore,
		events: IdentityListener,
		o: KeyCacheOptions = {},
	) {
		this.#identity = identity;
		this.#positiveTtlMs = o.positiveTtlMs ?? 30_000;
		this.#negativeTtlMs = o.negativeTtlMs ?? 5_000;
		this.#touchIntervalMs = o.touchIntervalMs ?? 60_000;
		this.#now = o.now ?? Date.now;
		this.#log = o.log;
		events.subscribe((c) => {
			if (c.all) this.flush();
			else if (c.collection === "api-keys") this.#invalidateKey(c.id);
			// The team name is cached with the key.
			else if (c.collection === "teams") this.flush();
		});
	}

	/** The key with this secret hash (revoked and expired keys included), or null. */
	async lookup(hash: string): Promise<CachedKey | null> {
		const e = this.#byHash.get(hash);
		const now = this.#now();
		if (e !== undefined) {
			const ttl = e.value === null ? this.#negativeTtlMs : this.#positiveTtlMs;
			if (now - e.at < ttl) return e.value;
			this.#drop(hash);
		}
		const running = this.#inflight.get(hash);
		if (running !== undefined) return running;
		const p: Promise<CachedKey | null> = this.#load(hash, now).finally(() => {
			// An invalidation may have replaced it with a newer load.
			if (this.#inflight.get(hash) === p) this.#inflight.delete(hash);
		});
		this.#inflight.set(hash, p);
		return p;
	}

	/** Records use of the key, at most once per interval (fire and forget). */
	touch(key: ApiKeyRecord): void {
		const now = this.#now();
		const last = this.#touched.get(key.id) ?? key.lastUsedAt?.getTime() ?? 0;
		if (now - last < this.#touchIntervalMs) return;
		this.#touched.set(key.id, now);
		this.#identity.touchApiKey(key.id).catch((err: unknown) => {
			this.#log?.warn(
				{
					apiKeyId: key.id,
					err: err instanceof Error ? err.message : String(err),
				},
				"touchApiKey failed",
			);
		});
	}

	/**
	 * Drops the key at once on this pod (revoke, rotate); other pods follow
	 * on the NOTIFY of the change.
	 */
	forget(id: string): void {
		this.#invalidateKey(id);
	}

	flush(): void {
		this.#generation++;
		// Loads started before the change must not be joined by new requests.
		this.#inflight.clear();
		this.#byHash.clear();
		this.#hashOf.clear();
	}

	async #load(hash: string, now: number): Promise<CachedKey | null> {
		const gen = this.#generation;
		const key = await this.#identity.findApiKeyByHash(hash);
		let value: CachedKey | null = null;
		if (key !== null) {
			const team = await this.#identity.team(key.teamId);
			// A deleted team revokes its keys (S8 §6.4).
			if (team !== null) value = { key, teamName: team.name };
		}
		// A change arrived while loading: do not cache what may predate it.
		if (gen === this.#generation) {
			if (this.#byHash.size >= MAX_ENTRIES) this.#prune(now);
			this.#byHash.set(hash, { at: now, value });
			if (value !== null) this.#hashOf.set(value.key.id, hash);
		}
		return value;
	}

	#invalidateKey(id: string): void {
		// In-flight loads must neither cache nor serve a pre-change answer.
		this.#generation++;
		this.#inflight.clear();
		const hash = this.#hashOf.get(id);
		if (hash !== undefined) this.#drop(hash);
		// A new key may have a negative entry under its hash (id unknown).
		for (const [h, e] of this.#byHash) {
			if (e.value === null) this.#byHash.delete(h);
		}
	}

	/** Drops expired entries; if still full, every negative one. */
	#prune(now: number): void {
		for (const [h, e] of this.#byHash) {
			const ttl = e.value === null ? this.#negativeTtlMs : this.#positiveTtlMs;
			if (now - e.at >= ttl) this.#drop(h);
		}
		if (this.#byHash.size < MAX_ENTRIES) return;
		for (const [h, e] of this.#byHash) {
			if (e.value === null) this.#byHash.delete(h);
		}
	}

	#drop(hash: string): void {
		const e = this.#byHash.get(hash);
		this.#byHash.delete(hash);
		if (e?.value) this.#hashOf.delete(e.value.key.id);
	}
}
