// Dependencies of the api apps and the Hono context variables. Later tasks
// add fields (svc, agent, streams, ...); tests build deps with
// `makeTestDeps(over)` from `@sbx/api/testing`.
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EnvironmentStore, IdentityStore, SshCa } from "@sbx/auth";
import type { ConfigReader } from "@sbx/config";
import type { JobSender, SandboxService } from "@sbx/core";
import type pg from "pg";
import type { Logger } from "pino";
import type { AgentApi } from "./agent/types.ts";
import type { IdentityListener } from "./auth/identity-listener.ts";
import type { ServiceTokens } from "./auth/internal.ts";
import type { KeyCache } from "./auth/key-cache.ts";
import type { OidcVerifier } from "./auth/oidc.ts";
import type { AuthContext, SessionResolver } from "./auth/principal.ts";
import type { RateLimits } from "./auth/rate-limit.ts";
import type { CommandTimings } from "./commands/attach.ts";
import type { PtyTimings } from "./commands/pty-socket.ts";
import type { StreamRegistry } from "./commands/registry.ts";
import type { ApiMetrics } from "./http/metrics.ts";
import type { Settings } from "./settings.ts";
import type { ApiLifecycle } from "./shutdown.ts";

export interface ApiDeps {
	settings: Settings;
	log: Logger;
	metrics: ApiMetrics;
	/** Postgres; null only in tests that need no database. */
	pool: pg.Pool | null;
	/** Gateway SSH host keys ("<type> <base64>") for `/v1/meta` and `/ssh`. */
	hostKeys: string[];
	/** SSH login CA (SBX_SSH_LOGIN_CA_KEY_FILE); null: no certificates. */
	sshCa: SshCa | null;
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
	/** Sandboxes, operations, env (S6 SandboxService). */
	svc: SandboxService;
	/** pg-boss jobs of core calls outside the service (agent events intake). */
	jobs: JobSender;
	/** Templates, sizes, quotas, platform defaults. */
	config: ConfigReader;
	/** Environments of the teams (PgEnvironmentStore until S8). */
	environments: EnvironmentStore;
	/** RPCs of the guest agents (UnwiredAgentApi until S3 is merged). */
	agent: AgentApi;
	/** Open NDJSON streams, sync waits and PTYs (limits, revocation, shutdown). */
	streams: StreamRegistry;
	/** Ready wait, heartbeat and max duration of command streams. */
	commandTimings: CommandTimings;
	/** Ping, input coalescing and backpressure of PTY WebSockets. */
	ptyTimings: PtyTimings;
	/** Shutting down: `/readyz` 503 and new requests 503 (S7 §9.7). */
	lifecycle: ApiLifecycle;
}

/** Hono env of every listener app. */
export interface ApiEnv {
	Variables: {
		/** Our `req_<ulid>`, also in the `Request-Id` response header. */
		requestId: string;
		/** A valid `Request-Id` sent by the client; logged only. */
		clientRequestId: string | undefined;
		/** Client address (X-Forwarded-For from a trusted proxy), for the request log. */
		clientIp: string | undefined;
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
