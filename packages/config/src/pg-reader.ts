// Shared SQL configuration reader for API and worker (S24).
// Lists and quotas are cached for ttlMs; the cache is dropped by any
// `umiak_config` notification and whenever LISTEN is re-established, so with
// LISTEN a change shows up right after its commit and without it after ttlMs.
// defaults() is never cached: routes.lookup needs the current policy (C7).

import type pg from "pg";
import { ChannelListener, CONFIG_CHANNEL } from "./config-listener.ts";
import { canonicalTemplateSlug } from "./template-slug.ts";
import type {
	ConfigReader,
	PlatformDefaults,
	Quota,
	SizeConfig,
	TemplateConfig,
	TemplateOs,
} from "./types.ts";

export interface PgConfigReaderOptions {
	pool: pg.Pool;
	/** LISTEN umiak_config on its own connection; without it only ttlMs applies. */
	listen?: { databaseUrl: string; reconnectDelayMs?: number };
	/** Cache lifetime; default 5000. */
	ttlMs?: number;
	/** Listener connection errors (it reconnects by itself). */
	onListenError?: (err: unknown) => void;
}

type Doc = Record<string, unknown>;

const DEFAULT_TTL_MS = 5_000;
// Cache of quotas by team id; unknown ids are cached too, so it is bounded.
const MAX_QUOTA_ENTRIES = 1_000;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same as StaticConfigReader.
const DEFAULT_CAPABILITIES = ["exec", "files", "ssh"];
const NO_QUOTA: Quota = {
	maxActiveSandboxes: 0,
	maxRamMb: 0,
	maxSavedSnapshots: 0,
};
// Used only when the platform default quota is empty (PoC quota, S8 §7).
const POC_QUOTA: Quota = {
	maxActiveSandboxes: 3,
	maxRamMb: 6144,
	maxSavedSnapshots: 10,
};

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function strings(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

function bySortOrderThenSlug(a: Doc, b: Doc): number {
	const d = (num(a.sortOrder) ?? 0) - (num(b.sortOrder) ?? 0);
	if (d !== 0) return d;
	const x = String(a.slug);
	const y = String(b.slug);
	return x < y ? -1 : x > y ? 1 : 0;
}

function template(d: Doc): TemplateConfig {
	const caps = Array.isArray(d.capabilities)
		? strings(d.capabilities)
		: DEFAULT_CAPABILITIES;
	return {
		slug: String(d.slug),
		name: typeof d.name === "string" && d.name !== "" ? d.name : String(d.slug),
		os: d.os as TemplateOs,
		enabled: d.enabled !== false,
		defaultSize: String(d.defaultSize),
		allowedSizes: strings(d.allowedSizes),
		loginUser:
			typeof d.loginUser === "string" && d.loginUser !== ""
				? d.loginUser
				: "user",
		capabilities: [...caps],
	};
}

function size(d: Doc): SizeConfig {
	return {
		slug: String(d.slug),
		vcpu: Number(d.vcpu),
		memoryMb: Number(d.memoryMb),
	};
}

/** `group` fields of a quota; an empty field is `null`. */
function quotaOf(g: unknown): { [K in keyof Quota]: number | null } {
	const q = (g ?? {}) as Doc;
	return {
		maxActiveSandboxes: num(q.maxActiveSandboxes),
		maxRamMb: num(q.maxRamMb),
		maxSavedSnapshots: num(q.maxSavedSnapshots),
	};
}

function mergeQuota(
	base: Quota,
	over: { [K in keyof Quota]: number | null },
): Quota {
	return {
		maxActiveSandboxes: over.maxActiveSandboxes ?? base.maxActiveSandboxes,
		maxRamMb: over.maxRamMb ?? base.maxRamMb,
		maxSavedSnapshots: over.maxSavedSnapshots ?? base.maxSavedSnapshots,
	};
}

interface Entry<T> {
	expires: number;
	value: Promise<T>;
}

export class PgConfigReader implements ConfigReader {
	readonly #pool: pg.Pool;
	readonly #ttlMs: number;
	readonly #listener: ChannelListener | null;
	readonly #cache = new Map<string, Entry<unknown>>();
	readonly #quotas = new Map<string, Entry<Quota>>();

	constructor(o: PgConfigReaderOptions) {
		this.#pool = o.pool;
		this.#ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
		this.#listener = o.listen
			? new ChannelListener({
					databaseUrl: o.listen.databaseUrl,
					channel: CONFIG_CHANNEL,
					onSignal: () => this.invalidate(),
					...(o.listen.reconnectDelayMs === undefined
						? {}
						: { reconnectDelayMs: o.listen.reconnectDelayMs }),
					...(o.onListenError ? { onError: o.onListenError } : {}),
				})
			: null;
	}

	/**
	 * Starts LISTEN umiak_config (when configured) and resolves once it is
	 * confirmed. Rejects when the first connection fails.
	 */
	async start(): Promise<void> {
		await this.#listener?.start();
	}

	async close(): Promise<void> {
		await this.#listener?.close();
		this.invalidate();
	}

	/** Drops every cached value. */
	invalidate(): void {
		this.#cache.clear();
		this.#quotas.clear();
	}

	async template(slug: string): Promise<TemplateConfig | null> {
		const t = (await this.#templates()).find(
			(x) => x.slug === canonicalTemplateSlug(slug),
		);
		return t ? copyTemplate(t) : null;
	}

	async size(slug: string): Promise<SizeConfig | null> {
		const s = (await this.#sizes()).find((x) => x.slug === slug);
		return s ? { ...s } : null;
	}

	async templates(): Promise<TemplateConfig[]> {
		return (await this.#templates()).map(copyTemplate);
	}

	async sizes(): Promise<SizeConfig[]> {
		return (await this.#sizes()).map((s) => ({ ...s }));
	}

	async teamExists(teamId: string, client: pg.PoolClient): Promise<boolean> {
		return (
			(await client.query("SELECT 1 FROM runtime.teams WHERE id=$1", [teamId]))
				.rowCount !== 0
		);
	}
	async teamQuota(teamId: string): Promise<Quota> {
		// A malformed id is an unknown team; Postgres would reject it.
		if (!UUID_RE.test(teamId)) return { ...NO_QUOTA };
		const key = teamId.toLowerCase();
		const hit = this.#quotas.get(key);
		if (hit && hit.expires > Date.now()) return { ...(await hit.value) };
		const entry: Entry<Quota> = {
			expires: Date.now() + this.#ttlMs,
			value: this.#loadQuota(key),
		};
		if (this.#quotas.size >= MAX_QUOTA_ENTRIES) this.#quotas.clear();
		this.#quotas.set(key, entry);
		try {
			return { ...(await entry.value) };
		} catch (err) {
			if (this.#quotas.get(key) === entry) this.#quotas.delete(key);
			throw err;
		}
	}

	/** Always read from the database (C7). */
	async defaults(): Promise<PlatformDefaults> {
		const g = await this.#global();
		return {
			ttlSeconds: num(g.ttlSeconds),
			maxTtlSeconds: num(g.maxTtlSeconds) ?? 604800,
			idleTimeoutSeconds: num(g.idleTimeoutSeconds),
			stoppedRetentionDays: num(g.stoppedRetentionDays),
			errorRetentionDays: num(g.errorRetentionDays) ?? 7,
			recoverMinIntervalSeconds: num(g.recoverMinIntervalSeconds) ?? 600,
			defaultTemplate:
				typeof g.defaultTemplate === "string" && g.defaultTemplate !== ""
					? g.defaultTemplate
					: "linux",
			publicPortsEnabled: g.publicPortsEnabled !== false,
			publicDesktopEnabled: g.publicDesktopEnabled === true,
		};
	}

	#templates(): Promise<TemplateConfig[]> {
		return this.#cached("templates", async () =>
			(await this.#all("templates")).sort(bySortOrderThenSlug).map(template),
		);
	}

	#sizes(): Promise<SizeConfig[]> {
		return this.#cached("sizes", async () =>
			(await this.#all("sizes")).sort(bySortOrderThenSlug).map(size),
		);
	}

	async #global(): Promise<Doc> {
		const row = (
			await this.#pool.query("SELECT * FROM runtime.platform_defaults")
		).rows[0];
		if (!row) throw new Error("platform defaults are missing; run migrations");
		return document(row);
	}

	async #all(collection: "templates" | "sizes"): Promise<Doc[]> {
		const table = {
			templates: "templates",
			sizes: "sizes",
		}[collection];
		const result = await this.#pool.query(`SELECT * FROM runtime.${table}`);
		return result.rows.map(document);
	}

	async #loadQuota(teamId: string): Promise<Quota> {
		const row = (
			await this.#pool.query("SELECT * FROM runtime.teams WHERE id=$1", [
				teamId,
			])
		).rows[0];
		const team = row ? document(row) : undefined;
		// A deleted or unknown team gets nothing: create refuses with quota_exceeded.
		if (!team) return { ...NO_QUOTA };
		const g = await this.#global();
		const base = mergeQuota(POC_QUOTA, quotaOf(g.defaultQuota));
		return mergeQuota(base, quotaOf(team.quota));
	}

	/**
	 * One load per key and ttl. A load that was started before an
	 * invalidation is no longer in the map, so it is not served afterwards.
	 */
	async #cached<T>(key: string, load: () => Promise<T>): Promise<T> {
		const hit = this.#cache.get(key) as Entry<T> | undefined;
		if (hit && hit.expires > Date.now()) return hit.value;
		const entry: Entry<T> = {
			expires: Date.now() + this.#ttlMs,
			value: load(),
		};
		this.#cache.set(key, entry);
		try {
			return await entry.value;
		} catch (err) {
			if (this.#cache.get(key) === entry) this.#cache.delete(key);
			throw err;
		}
	}
}

function copyTemplate(t: TemplateConfig): TemplateConfig {
	return {
		...t,
		allowedSizes: [...t.allowedSizes],
		capabilities: [...t.capabilities],
	};
}

/** Map SQL names to the existing reader contract, including nullable quota groups. */
function document(row: Record<string, unknown>): Doc {
	const result: Doc = {};
	for (const [key, raw] of Object.entries(row)) {
		const value = raw instanceof Date ? raw.toISOString() : raw;
		const property = key.replace(/_([a-z])/g, (_, letter: string) =>
			letter.toUpperCase(),
		);
		const group = [
			"default_quota_",
			"new_shared_team_quota_",
			"rate_limits_",
			"quota_",
		].find((prefix) => key.startsWith(prefix));
		if (!group) {
			result[property] = value;
			continue;
		}
		const groupName = group
			.slice(0, -1)
			.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
		const field = key
			.slice(group.length)
			.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
		result[groupName] ??= {};
		const values = result[groupName] as Doc;
		values[field] = value;
	}
	return result;
}
