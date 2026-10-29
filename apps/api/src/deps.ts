// Dependencies of the api apps and the Hono context variables. Later tasks
// add fields (svc, agent, streams, ...); tests build deps with
// `makeTestDeps(over)` from `@sbx/api/testing`.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { IdentityStore } from "@sbx/auth";
import type pg from "pg";
import type { Logger } from "pino";
import type { IdentityListener } from "./auth/identity-listener.ts";
import type { ServiceTokens } from "./auth/internal.ts";
import type { KeyCache } from "./auth/key-cache.ts";
import type { OidcVerifier } from "./auth/oidc.ts";
import type { AuthContext, SessionResolver } from "./auth/principal.ts";
import type { RateLimits } from "./auth/rate-limit.ts";
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
	/** Users, teams, keys (PgIdentityStore until S8). */
	identity: IdentityStore;
	/** LISTEN sbx_identity; its connection is part of `/readyz`. */
	identityEvents: IdentityListener;
	/** Team keys by secret hash (30 s / 5 s, flushed by identityEvents). */
	keyCache: KeyCache;
	/** Cached resolveSession for browser sessions and Keycloak tokens. */
	sessions: SessionResolver;
	/** Keycloak access tokens; null without SBX_OIDC_ISSUER. */
	oidc: OidcVerifier | null;
	/** Accepted service tokens of the internal listener. */
	serviceTokens: ServiceTokens;
	rateLimits: RateLimits;
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
		/** Caller of an authenticated public/proxied route; read it with `authOf(c)`. */
		auth: AuthContext | undefined;
		/** Internal listener: the service of the token (`gateway`). */
		serviceCaller: string | undefined;
	};
}

/** A listener app with OpenAPI routes (public, proxied, internal). */
export type ApiApp = OpenAPIHono<ApiEnv>;
