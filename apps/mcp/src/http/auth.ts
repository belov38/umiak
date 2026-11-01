// Bearer check of the remote MCP server (S11 6.3, 11.5): the bearer is
// asked to the api itself (GET /v1/me with this bearer and team), and the
// answer is cached in the pod by sha256(token) and team. A JWT is decoded
// without verifying it, only for the cache lifetime and the 55 s rule:
// the api decides whether it is valid.
import { createHash } from "node:crypto";
import { Umiak, UmiakError } from "@umiak/sdk";
import type { Metrics } from "../metrics.ts";

/** A JWT with less than this left is refused: a call may take 50 s. */
export const EXP_MARGIN_MS = 55_000;
/** Longest life of a successful check in the cache. */
export const ME_OK_TTL_MS = 30_000;
/** Life of a refused check in the cache. */
export const ME_FAIL_TTL_MS = 5_000;
/** GET /v1/me gives up after this long (503 to the client). */
export const ME_TIMEOUT_MS = 5_000;
/** Cached checks per pod; the oldest go first beyond it. */
export const ME_CACHE_MAX_ENTRIES = 10_000;

export interface Principal {
	/** The bearer of this request: forwarded to the api as is, never another (6.5). */
	token: string;
	/** Team requested by Umiak-Team or `?team=`; absent: the default team. */
	team?: string;
	kind: "oidc" | "team_key" | "session";
	scopes: string[];
	/** JWT `exp` in ms; null for team keys. */
	expiresAt: number | null;
	/** The person or key behind the bearer (the concurrency limit counts by it). */
	subject: string;
}

/** A refused bearer, answered before MCP. */
export interface AuthRejection {
	status: 400 | 401 | 403 | 503;
	/** Metric label: why. */
	reason: string;
	/** Error envelope of the body (as the api's). */
	code: string;
	message: string;
	/** `error=` of the challenge (401 only). */
	challenge?: { error: string; description?: string };
}

type Checked = Omit<Principal, "token" | "team">;
type Verdict = { principal: Checked } | { rejection: AuthRejection };

export function isRejection(v: unknown): v is AuthRejection {
	return typeof v === "object" && v !== null && "status" in v && "code" in v;
}

/** The token of `Authorization: Bearer <token>`; null without one. Never the query. */
export function bearerOf(req: Request): string | null {
	const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(
		req.headers.get("authorization") ?? "",
	);
	return m?.[1] ?? null;
}

export function tokenHash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** `exp` of a JWT in ms, read without checking the signature; null when it is not a JWT. */
export function jwtExpiresAt(token: string): number | null {
	if (token.startsWith("umiak_")) return null;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined) return null;
	try {
		const payload: unknown = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		);
		const exp = (payload as { exp?: unknown } | null)?.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
	} catch {
		return null;
	}
}

/** Results of GET /v1/me per (sha256(token), team), in memory only. */
export class MeCache {
	readonly #entries = new Map<string, { until: number; verdict: Verdict }>();
	readonly #now: () => number;
	readonly #max: number;

	constructor(o: { now?: () => number; maxEntries?: number } = {}) {
		this.#now = o.now ?? Date.now;
		this.#max = o.maxEntries ?? ME_CACHE_MAX_ENTRIES;
	}

	static key(token: string, team: string | undefined): string {
		return `${tokenHash(token)}\n${team ?? ""}`;
	}

	get size(): number {
		return this.#entries.size;
	}

	get(token: string, team: string | undefined): Verdict | undefined {
		const key = MeCache.key(token, team);
		const e = this.#entries.get(key);
		if (e === undefined) return undefined;
		if (e.until <= this.#now()) {
			this.#entries.delete(key);
			return undefined;
		}
		return e.verdict;
	}

	set(
		token: string,
		team: string | undefined,
		verdict: Verdict,
		ttlMs: number,
	): void {
		if (ttlMs <= 0) return;
		const key = MeCache.key(token, team);
		this.#entries.delete(key);
		this.#entries.set(key, { until: this.#now() + ttlMs, verdict });
		if (this.#entries.size > this.#max) this.#evict();
	}

	delete(token: string, team: string | undefined): void {
		this.#entries.delete(MeCache.key(token, team));
	}

	#evict(): void {
		const now = this.#now();
		for (const [k, e] of this.#entries) {
			if (e.until <= now) this.#entries.delete(k);
		}
		// Insertion order is age order: drop the oldest.
		for (const k of this.#entries.keys()) {
			if (this.#entries.size <= this.#max) break;
			this.#entries.delete(k);
		}
	}
}

const KINDS = new Set<string>(["oidc", "team_key", "session"]);

export interface AuthenticatorOptions {
	apiUrl: string;
	fetch?: typeof fetch;
	cache: MeCache;
	now?: () => number;
	metrics?: Metrics;
	userAgent: string;
}

export type Authenticate = (
	token: string,
	team: string | undefined,
) => Promise<Principal | AuthRejection>;

function rejectionOf(err: unknown): {
	rejection: AuthRejection;
	cache: boolean;
} {
	if (err instanceof UmiakError && err.status === 401) {
		return {
			rejection: {
				status: 401,
				reason: err.code,
				code: "unauthorized",
				message: err.message,
				challenge: { error: "invalid_token", description: err.message },
			},
			cache: true,
		};
	}
	if (err instanceof UmiakError && (err.status === 403 || err.status === 400)) {
		const reason = err.details.reason;
		return {
			rejection: {
				status: err.status,
				reason: typeof reason === "string" ? reason : err.code,
				code: err.code,
				message: err.message,
			},
			cache: true,
		};
	}
	// The api did not answer (or failed): not the bearer's fault, not cached.
	return {
		rejection: {
			status: 503,
			reason: "api_unavailable",
			code: "api_unavailable",
			message: "the umiak API did not answer the credential check; retry",
		},
		cache: false,
	};
}

/** Checks a bearer through GET /v1/me with the cache; concurrent misses share one call. */
export function createAuthenticator(o: AuthenticatorOptions): Authenticate {
	const now = o.now ?? Date.now;
	const pending = new Map<string, Promise<Verdict>>();

	async function ask(token: string, team: string | undefined) {
		o.metrics?.meCacheMisses.inc();
		const exp = jwtExpiresAt(token);
		const umiak = new Umiak({
			baseUrl: o.apiUrl,
			...(token.startsWith("umiak_")
				? { apiKey: token }
				: { accessToken: token }),
			...(team === undefined ? {} : { team }),
			...(o.fetch === undefined ? {} : { fetch: o.fetch }),
			userAgent: o.userAgent,
			env: {},
		});
		let verdict: Verdict;
		let ttl: number;
		try {
			const me = await umiak.me({
				signal: AbortSignal.timeout(ME_TIMEOUT_MS),
				retryBudgetMs: ME_TIMEOUT_MS,
			});
			const kind = me.auth.kind;
			if (!KINDS.has(kind)) throw new Error(`unknown credential kind ${kind}`);
			const subject =
				me.user?.id ?? me.auth.apiKeyId ?? `token:${tokenHash(token)}`;
			verdict = {
				principal: {
					kind: kind as Principal["kind"],
					scopes: [...me.auth.scopes],
					expiresAt: exp,
					subject: `${kind}:${subject}`,
				},
			};
			ttl = Math.min(ME_OK_TTL_MS, exp === null ? ME_OK_TTL_MS : exp - now());
		} catch (err) {
			const r = rejectionOf(err);
			verdict = { rejection: r.rejection };
			ttl = r.cache ? ME_FAIL_TTL_MS : 0;
		}
		o.cache.set(token, team, verdict, ttl);
		return verdict;
	}

	return async (token, team) => {
		const exp = jwtExpiresAt(token);
		if (exp !== null && exp - now() < EXP_MARGIN_MS) {
			return {
				status: 401,
				reason: "expires_soon",
				code: "unauthorized",
				message: "token expires too soon",
				challenge: {
					error: "invalid_token",
					description: "token expires too soon",
				},
			};
		}
		let verdict = o.cache.get(token, team);
		if (verdict === undefined) {
			const key = MeCache.key(token, team);
			let p = pending.get(key);
			if (p === undefined) {
				p = ask(token, team).finally(() => pending.delete(key));
				pending.set(key, p);
			}
			verdict = await p;
		}
		if ("rejection" in verdict) return verdict.rejection;
		return {
			...verdict.principal,
			token,
			...(team === undefined ? {} : { team }),
		};
	};
}
