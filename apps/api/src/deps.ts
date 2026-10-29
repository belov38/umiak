// Dependencies of the api apps and the Hono context variables. Later tasks
// add fields (svc, identity, agent, streams, ...); tests build deps with
// `makeTestDeps(over)` from `@sbx/api/testing`.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type pg from "pg";
import type { Logger } from "pino";
import type { ApiMetrics } from "./http/metrics.ts";
import type { Settings } from "./settings.ts";

export interface ApiDeps {
	settings: Settings;
	log: Logger;
	metrics: ApiMetrics;
	/** Postgres; null only in tests that need no database. */
	pool: pg.Pool | null;
	/** Gateway SSH host keys ("<type> <base64>") for `/v1/meta`. */
	hostKeys: string[];
}

/** Hono env of every listener app. */
export interface ApiEnv {
	Variables: {
		/** Our `req_<ulid>`, also in the `Request-Id` response header. */
		requestId: string;
		/** A valid `Request-Id` sent by the client; logged only. */
		clientRequestId: string | undefined;
		/** Error code of an error response, for the request log. */
		errorCode: string | undefined;
	};
}

/** A listener app with OpenAPI routes (public, proxied, internal). */
export type ApiApp = OpenAPIHono<ApiEnv>;
