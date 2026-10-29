// Listener apps (S7 §7.1):
//   public   :8080  SDK, CLI, MCP, CI          -> createPublicApp
//   proxied  :8081  browser via oauth2-proxy   -> createProxiedApp
//   internal :8082  gateway, service tokens    -> createInternalApp
//   ops      :9090  /healthz, /readyz, /metrics -> createOpsApp
// Public and proxied serve the same `/v1` resources (`mountV1`); they differ
// only in authentication.
import { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { ApiApp, ApiDeps, ApiEnv } from "./deps.ts";
import { bodyLimits } from "./http/body-limit.ts";
import {
	ApiError,
	type ErrorRenderOptions,
	notFoundHandler,
	onErrorHandler,
	zodValidationError,
} from "./http/errors.ts";
import { requestLog } from "./http/logger.ts";
import { requestMetrics } from "./http/metrics.ts";
import { requestId } from "./http/request-id.ts";
import { registerSecuritySchemes } from "./openapi/registry.ts";
import { registerMetaRoutes } from "./routes/meta.ts";

/** Common middleware and error handling of the listener apps. */
function listenerApp(deps: ApiDeps, o: ErrorRenderOptions = {}): ApiApp {
	const app = new OpenAPIHono<ApiEnv>({
		// zod validation of params, query, headers and body -> 400 validation.
		defaultHook: (result) => {
			if (!result.success)
				throw zodValidationError(result.target, result.error);
		},
	});
	app.use(
		"*",
		requestId(),
		requestLog(deps.log),
		requestMetrics(deps.metrics),
		bodyLimits(),
	);
	app.onError(onErrorHandler(deps.log, o));
	app.notFound(notFoundHandler(() => app.routes, o));
	return app;
}

/** Mounts the `/v1` resources shared by the public and proxied listeners. */
export function mountV1(app: ApiApp, deps: ApiDeps): void {
	registerSecuritySchemes(app);
	registerMetaRoutes(app, deps);
}

export function createPublicApp(deps: ApiDeps): ApiApp {
	const app = listenerApp(deps);
	mountV1(app, deps);
	return app;
}

export function createProxiedApp(deps: ApiDeps): ApiApp {
	const app = listenerApp(deps);
	mountV1(app, deps);
	return app;
}

export function createInternalApp(deps: ApiDeps): ApiApp {
	return listenerApp(deps, { topLevelCode: true });
}

const READY_TIMEOUT_MS = 2000;

async function postgresAnswers(pool: pg.Pool): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			pool.query("SELECT 1").then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/** `/healthz` (liveness), `/readyz` (Postgres), `/metrics` (Prometheus). */
export function createOpsApp(deps: ApiDeps): ApiApp {
	const app = new OpenAPIHono<ApiEnv>();
	app.use("*", requestId());
	app.onError(onErrorHandler(deps.log));
	app.notFound(notFoundHandler(() => app.routes));
	app.get("/healthz", (c) => c.json({ ok: true }));
	app.get("/readyz", async (c) => {
		const reasons: string[] = [];
		if (deps.pool !== null && !(await postgresAnswers(deps.pool))) {
			reasons.push("postgres");
		}
		if (reasons.length > 0) {
			throw new ApiError(503, "not_ready", `not ready: ${reasons.join(", ")}`, {
				retryable: true,
				details: { reasons },
			});
		}
		return c.json({ ready: true, reasons });
	});
	app.get("/metrics", async (c) => {
		const r = deps.metrics.registry;
		return c.body(await r.metrics(), 200, { "Content-Type": r.contentType });
	});
	return app;
}
