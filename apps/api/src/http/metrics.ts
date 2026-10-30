// Prometheus metrics of the api (S7 §21 minimum). Every metric is created
// here with a fixed label set; later code uses the typed fields.
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import {
	Counter,
	collectDefaultMetrics,
	Gauge,
	Histogram,
	Registry,
} from "prom-client";
import type { ApiEnv } from "../deps.ts";

/** Label of requests that matched no route (keeps URLs out of labels). */
export const UNMATCHED_ROUTE = "unmatched";

export interface ApiMetricsOptions {
	/** Node.js process metrics (CPU, memory, event loop). Default false. */
	defaultMetrics?: boolean;
}

export class ApiMetrics {
	readonly registry = new Registry();
	/** Requests per route template, method and status. */
	readonly requests: Counter<"route" | "method" | "status">;
	/** Request time until the response head (streams: until it starts). */
	readonly duration: Histogram<"route" | "method">;
	/** Open NDJSON streams and WebSockets per kind (`stream`, `pty`). */
	readonly openStreams: Gauge<"kind">;
	/** Reattaches to the agent per segment (`agent`, `client`). */
	readonly reattaches: Counter<"segment">;
	/** Agent calls per method and outcome (`ok` or an error code). */
	readonly agentCalls: Counter<"method" | "outcome">;
	/** Authentication failures per reason. */
	readonly authFailures: Counter<"reason">;
	/** 429 answers per limit (`requests`, `starts`, `streams`). */
	readonly rateLimited: Counter<"limit">;

	constructor(o: ApiMetricsOptions = {}) {
		const registers = [this.registry];
		this.requests = new Counter({
			name: "sbx_api_requests_total",
			help: "HTTP requests per route template, method and status",
			labelNames: ["route", "method", "status"],
			registers,
		});
		this.duration = new Histogram({
			name: "sbx_api_request_duration_seconds",
			help: "HTTP request time per route template and method",
			labelNames: ["route", "method"],
			buckets: [
				0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
			],
			registers,
		});
		this.openStreams = new Gauge({
			name: "sbx_api_open_streams",
			help: "Open NDJSON streams and WebSockets per kind",
			labelNames: ["kind"],
			registers,
		});
		this.reattaches = new Counter({
			name: "sbx_api_reattach_total",
			help: "Stream reattaches per segment",
			labelNames: ["segment"],
			registers,
		});
		this.agentCalls = new Counter({
			name: "sbx_api_agent_calls_total",
			help: "Agent calls per method and outcome",
			labelNames: ["method", "outcome"],
			registers,
		});
		this.authFailures = new Counter({
			name: "sbx_api_auth_failures_total",
			help: "Authentication failures per reason",
			labelNames: ["reason"],
			registers,
		});
		this.rateLimited = new Counter({
			name: "sbx_api_rate_limited_total",
			help: "Requests refused with 429 per limit",
			labelNames: ["limit"],
			registers,
		});
		if (o.defaultMetrics) collectDefaultMetrics({ register: this.registry });
	}
}

/**
 * Route template the request matched, or `unmatched`. Taken from the
 * matched routes (last non-middleware entry), not from the handler that ran,
 * so answers produced in middleware (413, 401, 429) keep their route.
 */
export function routeLabel(c: Context): string {
	const r = matchedRoutes(c).findLast((m) => m.method !== "ALL");
	return r?.path ?? UNMATCHED_ROUTE;
}

export function requestMetrics(m: ApiMetrics): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const end = m.duration.startTimer();
		await next();
		const route = routeLabel(c);
		const method = c.req.method;
		end({ route, method });
		m.requests.inc({ route, method, status: String(c.res.status) });
	};
}
