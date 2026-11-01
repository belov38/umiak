// Rate limits in the pod's memory (S7 §5.8, rate-limiter-flexible):
//   requests: per principal (API key, else user), 20/s with a burst of 100,
//     i.e. 100 requests per 5 s window; headers `RateLimit-Policy` and
//     `RateLimit` (IETF draft) on every authenticated answer;
//   starts (create, fork, resume): 30 per minute per team.
// With several pods the effective limit multiplies; quotas and admission
// protect the nodes, these limits protect the api itself.
import type { Principal } from "@umiak/core";
import type { MiddlewareHandler } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import type { ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import type { Settings } from "../settings.ts";
import { authOf } from "./principal.ts";

export type RateLimitName = "requests" | "starts";

export class RateLimits {
	/** Quota and window (seconds) of the request limit, for the headers. */
	readonly quota: number;
	readonly windowSeconds: number;
	readonly #requests: RateLimiterMemory;
	readonly #starts: RateLimiterMemory;

	constructor(rate: Settings["rate"]) {
		this.quota = rate.burst;
		this.windowSeconds = Math.max(1, Math.ceil(rate.burst / rate.rps));
		this.#requests = new RateLimiterMemory({
			keyPrefix: "req",
			points: this.quota,
			duration: this.windowSeconds,
		});
		this.#starts = new RateLimiterMemory({
			keyPrefix: "starts",
			points: rate.startsPerMinute,
			duration: 60,
		});
	}

	/** `RateLimit-Policy` value. */
	get policy(): string {
		return `"req";q=${this.quota};w=${this.windowSeconds}`;
	}

	consume(name: RateLimitName, key: string): Promise<RateLimitResult> {
		const limiter = name === "requests" ? this.#requests : this.#starts;
		return limiter.consume(key).then(
			(r) => ({
				allowed: true,
				remaining: r.remainingPoints,
				resetMs: r.msBeforeNext,
			}),
			(e: unknown) => {
				if (e instanceof RateLimiterRes) {
					return { allowed: false, remaining: 0, resetMs: e.msBeforeNext };
				}
				throw e;
			},
		);
	}
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetMs: number;
}

/** Bucket of a principal: the API key, else the user. */
export function rateLimitKey(p: Principal): string {
	return p.apiKeyId ?? p.userId ?? `team:${p.teamId}`;
}

function rateLimited(
	limit: RateLimitName,
	resetMs: number,
	headers: Record<string, string> = {},
): ApiError {
	const seconds = Math.max(1, Math.ceil(resetMs / 1000));
	const what =
		limit === "requests"
			? "too many requests"
			: "too many sandbox starts (create, fork, resume) for this team";
	return new ApiError(429, "rate_limited", `${what}; retry in ${seconds} s`, {
		retryable: true,
		details: { limit, retryAfterSeconds: seconds },
		headers,
	});
}

/** Request limit; after authentication, skipped for anonymous routes. */
export function rateLimit(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	const limits = deps.rateLimits;
	return async (c, next) => {
		const auth = c.var.auth;
		if (auth === undefined) return next();
		const r = await limits.consume("requests", rateLimitKey(auth.principal));
		const t = Math.max(1, Math.ceil(r.resetMs / 1000));
		const headers = {
			"RateLimit-Policy": limits.policy,
			RateLimit: `"req";r=${r.remaining};t=${t}`,
		};
		if (!r.allowed) {
			deps.metrics.rateLimited.inc({ limit: "requests" });
			throw rateLimited("requests", r.resetMs, headers);
		}
		for (const [k, v] of Object.entries(headers)) c.header(k, v);
		await next();
	};
}

/** Start limit per team; put on `create`, `fork` and `resume`. */
export function limitStarts(deps: ApiDeps): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const r = await deps.rateLimits.consume(
			"starts",
			authOf(c).principal.teamId,
		);
		if (!r.allowed) {
			deps.metrics.rateLimited.inc({ limit: "starts" });
			throw rateLimited("starts", r.resetMs);
		}
		await next();
	};
}
