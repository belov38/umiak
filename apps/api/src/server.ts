// The api process: production dependencies from the settings and the four
// listeners (S7 §7.1).
//   public   SBX_API_PUBLIC_PORT   (8080)  SDK, CLI, MCP, CI; WebSockets
//   proxied  SBX_API_PROXIED_PORT  (8081)  browser via oauth2-proxy; WebSockets
//   internal SBX_API_INTERNAL_PORT (8082)  gateway, service tokens
//   ops      SBX_API_METRICS_PORT  (9090)  /healthz, /readyz, /metrics
// `close()` is the graceful stop of shutdown.ts (at most 10 s).
// Identities and config come from Payload (S8 plan decision 5): the Local
// API of `@sbx/payload` with its own pg pool; its migrations are applied by
// `node packages/payload/src/migrate.ts` (compose: web-migrate), not here.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import { AgentClient, PgRegistry } from "@sbx/agent-client";
import { PgEnvironmentStore } from "@sbx/auth";
import {
	ensureQueues,
	KeyRing,
	PgBossJobSender,
	PgNotifier,
	SandboxServiceImpl,
	validateSecretSets,
} from "@sbx/core";
import { createPool } from "@sbx/db";
import { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { ConnectAgentApi } from "./agent/connect.ts";
import {
	createInternalApp,
	createOpsApp,
	createProxiedApp,
	createPublicApp,
} from "./app.ts";
import { IdentityListener } from "./auth/identity-listener.ts";
import { loadServiceTokens } from "./auth/internal.ts";
import { KeyCache } from "./auth/key-cache.ts";
import { OidcVerifier } from "./auth/oidc.ts";
import { SessionResolver } from "./auth/principal.ts";
import { RateLimits } from "./auth/rate-limit.ts";
import { DEFAULT_COMMAND_TIMINGS } from "./commands/attach.ts";
import { DEFAULT_PTY_TIMINGS } from "./commands/pty-socket.ts";
import { blockedSandboxesOf, StreamRegistry } from "./commands/registry.ts";
import type { ApiDeps } from "./deps.ts";
import { createApiLogger } from "./http/logger.ts";
import { ApiMetrics } from "./http/metrics.ts";
import { createApiServer } from "./http/websocket.ts";
import { readHostKeys, readSshCa, type Settings } from "./settings.ts";
import { ApiLifecycle, type Listener, shutdown } from "./shutdown.ts";

/** Postgres connections of the request pool. */
const DB_POOL_MAX = 20;

/**
 * Connections of the Payload adapter pool (identity reads on key cache
 * misses and session resolution, config reads; the adapter keeps one).
 */
const PAYLOAD_POOL_MAX = 10;

/** How long an agent call waits for the machine's tunnel (S7 §9.7). */
const AGENT_WAIT_MS = 30_000;

/** pg-boss schema (the worker's BOSS_SCHEMA). */
const BOSS_SCHEMA = "pgboss";

/**
 * Idle keep-alive connections stay open longer than the idle timeout of
 * the proxies in front (ingress, oauth2-proxy), so a proxy never reuses a
 * connection the server is closing.
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

export interface ProductionDeps {
	deps: ApiDeps;
	/** Releases the pools (Payload's too), the LISTEN connections and pg-boss. */
	dispose(): Promise<void>;
}

function errText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function readToken(file: string): string {
	const t = readFileSync(file, "utf8").trim();
	if (t === "") throw new Error(`gateway token file ${file} is empty`);
	return t;
}

/**
 * The real dependencies: files are read first (a broken one fails the start
 * before anything connects), then Postgres, LISTEN sbx_identity (shared with
 * the service's waits), Payload with the config reader (LISTEN sbx_config),
 * the identity file (loaded into Payload), pg-boss (send only) and the agent
 * registry of the gateway tunnels.
 */
export async function buildDeps(
	settings: Settings,
	log: Logger,
): Promise<ProductionDeps> {
	const keys = KeyRing.fromFile(settings.dataKeysFile);
	const serviceTokens = loadServiceTokens(settings.serviceTokensFile);
	const hostKeys = readHostKeys(settings.sshHostKeysFile);
	const sshCa = readSshCa(settings.sshLoginCaKeyFile);
	const gatewayToken =
		settings.gatewayTokenFile === null
			? null
			: readToken(settings.gatewayTokenFile);
	const identityYaml =
		settings.identityFile === null
			? null
			: readFileSync(settings.identityFile, "utf8");

	const cleanups: (() => Promise<void>)[] = [];
	const dispose = async () => {
		for (const fn of cleanups.splice(0).reverse()) {
			await fn().catch((e: unknown) =>
				log.warn({ err: errText(e) }, "releasing a resource failed"),
			);
		}
	};
	try {
		const pool = createPool(settings.databaseUrl, DB_POOL_MAX, {
			onError: (err) =>
				log.error({ err: err.message }, "postgres pool: idle client error"),
		});
		cleanups.push(() => pool.end());

		let identityEvents: IdentityListener | null = null;
		const notifier = new PgNotifier({
			connectionString: settings.databaseUrl,
			onError: (err) => identityEvents?.connectionLost(err),
		});
		identityEvents = new IdentityListener(notifier, { log });
		const events = identityEvents;
		cleanups.push(() => events.close());
		events.start();

		// Loaded here, not at module load: tests import this module through
		// the package index without needing Payload.
		const sbx = await import("@sbx/payload");
		const databaseUrl = settings.databaseUrl;
		const payload = await sbx.getSbxPayload({
			databaseUrl,
			secret: settings.payloadSecret,
			operatorGroups: settings.operatorGroups,
			appOrigin: settings.appOrigin,
			poolMax: PAYLOAD_POOL_MAX,
		});
		cleanups.push(() => sbx.closeSbxPayload(databaseUrl));
		const config = new sbx.PayloadConfigReader({
			payload,
			listen: { databaseUrl },
			onListenError: (err) =>
				log.warn({ err: errText(err) }, "LISTEN sbx_config: connection lost"),
		});
		await config.start();
		cleanups.push(() => config.close());

		if (identityYaml !== null) {
			await sbx.assertPayloadMigrated(payload).catch((e: unknown) => {
				throw new Error(
					`SBX_IDENTITY_FILE cannot be loaded: ${errText(e)} (run packages/payload/src/migrate.ts)`,
				);
			});
			const r = await sbx.seedPayloadIdentity(payload, identityYaml);
			log.info({ ...r }, "identity file loaded");
		}

		const boss = new PgBoss({
			db: {
				executeSql: (text, values) => pool.query(text, values as unknown[]),
			},
			schema: BOSS_SCHEMA,
			// Send only: the worker supervises, schedules and works the queues.
			supervise: false,
			schedule: false,
			registerInstance: false,
		});
		boss.on("error", (err) =>
			log.error({ err: errText(err) }, "pg-boss error"),
		);
		await boss.start();
		cleanups.push(() => boss.stop({ graceful: false }));
		await ensureQueues(boss);
		const jobs = new PgBossJobSender(boss);

		let agentClient: AgentClient | null = null;
		if (gatewayToken === null) {
			log.warn(
				"SBX_API_GATEWAY_TOKEN_FILE is not set: agent calls answer 503 agent_unavailable",
			);
		} else {
			const registry = await PgRegistry.connect({
				connectionString: settings.databaseUrl,
				maxConnections: 4,
			});
			cleanups.push(() => registry.close());
			agentClient = new AgentClient({
				registry,
				serviceToken: gatewayToken,
				waitForAgentMs: AGENT_WAIT_MS,
			});
			const client = agentClient;
			// Before the registry (cleanups run in reverse): its HTTP/2 sessions.
			cleanups.push(() => client.close());
		}

		const identity = new sbx.PayloadIdentityStore({
			payload,
			operatorGroups: settings.operatorGroups,
		});
		const streams = new StreamRegistry({
			identity,
			events,
			maxPerPrincipal: settings.maxStreams,
			blockedSandboxes: blockedSandboxesOf(pool),
			log,
		});
		cleanups.push(async () => streams.close());
		const deps: ApiDeps = {
			settings,
			log,
			metrics: new ApiMetrics({ defaultMetrics: true }),
			pool,
			hostKeys,
			sshCa,
			identity,
			identityEvents: events,
			keyCache: new KeyCache(identity, events, { log }),
			sessions: new SessionResolver(identity, events),
			oidc: settings.oidc === null ? null : new OidcVerifier(settings.oidc),
			serviceTokens,
			rateLimits: new RateLimits(settings.rate),
			svc: new SandboxServiceImpl({
				pool,
				config,
				keys,
				jobs,
				notifier,
				log,
			}),
			jobs,
			config,
			environments: new PgEnvironmentStore(pool, keys, {
				validateSets: validateSecretSets,
			}),
			agent: new ConnectAgentApi(agentClient, pool),
			streams,
			commandTimings: { ...DEFAULT_COMMAND_TIMINGS },
			ptyTimings: { ...DEFAULT_PTY_TIMINGS },
			lifecycle: new ApiLifecycle(),
			payloadReady: () => sbx.assertPayloadMigrated(payload),
		};
		return { deps, dispose };
	} catch (e) {
		await dispose();
		throw e;
	}
}

export interface ApiPorts {
	public: number;
	/** null when SBX_API_PROXIED_ENABLED is off. */
	proxied: number | null;
	internal: number;
	metrics: number;
}

export interface StartOptions {
	/** Bind address; default all interfaces. */
	host?: string;
	/** Upper bound of `close()` (default SHUTDOWN_GRACE_MS, 10 s). */
	graceMs?: number;
	/** Logger of the production deps (default from SBX_LOG_LEVEL). */
	log?: Logger;
}

export interface RunningApi {
	ports: ApiPorts;
	deps: ApiDeps;
	/** Graceful stop (idempotent: every call returns the same promise). */
	close(): Promise<void>;
}

function listen(server: Server, port: number, host?: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const fail = (e: Error) => reject(e);
		server.once("error", fail);
		const done = () => {
			server.off("error", fail);
			resolve((server.address() as AddressInfo).port);
		};
		if (host === undefined) server.listen(port, done);
		else server.listen(port, host, done);
	});
}

function plainServer(app: {
	fetch: (r: Request, env: never) => unknown;
}): Server {
	return createAdaptorServer({ fetch: app.fetch as never }) as Server;
}

/**
 * Starts the four listeners. Without `deps` the production dependencies are
 * built from `settings` and released by `close()`; given `deps` (tests)
 * stay the caller's. Ports come from `settings` (0: any free port).
 */
export async function startApi(
	settings: Settings,
	deps?: ApiDeps,
	o: StartOptions = {},
): Promise<RunningApi> {
	const built: ProductionDeps =
		deps === undefined
			? await buildDeps(
					settings,
					o.log ?? createApiLogger({ level: settings.logLevel }),
				)
			: { deps, dispose: async () => {} };
	const d = built.deps;

	const pub = createApiServer(createPublicApp(d));
	const listeners: Listener[] = [{ name: "public", ...pub }];
	const prox = settings.proxiedEnabled
		? createApiServer(createProxiedApp(d))
		: null;
	if (prox !== null) listeners.push({ name: "proxied", ...prox });
	listeners.push({
		name: "internal",
		server: plainServer(createInternalApp(d)),
	});
	const ops: Listener = { name: "ops", server: plainServer(createOpsApp(d)) };
	for (const l of listeners) {
		l.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
		// Above the keep-alive timeout, as Node recommends.
		l.server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1000;
		// Uploads to /files may take longer than Node's 300 s default, so
		// there is no server-wide request timeout: the headers timeout bounds
		// clients that never finish the headers, and bodyLimits bounds every
		// limited (non-file) body to 60 s, an upload chunk to 30 s without
		// bytes; bodies are read only by handlers, after authentication.
		l.server.requestTimeout = 0;
	}

	const ports: ApiPorts = { public: 0, proxied: null, internal: 0, metrics: 0 };
	try {
		ports.public = await listen(pub.server, settings.publicPort, o.host);
		if (prox !== null) {
			ports.proxied = await listen(prox.server, settings.proxiedPort, o.host);
		}
		const internal = listeners.find((l) => l.name === "internal") as Listener;
		ports.internal = await listen(
			internal.server,
			settings.internalPort,
			o.host,
		);
		ports.metrics = await listen(ops.server, settings.metricsPort, o.host);
	} catch (e) {
		for (const l of [...listeners, ops]) {
			if (l.server.listening) l.server.close();
		}
		await built.dispose();
		throw e;
	}
	d.log.info({ ports, build: settings.build }, "api listening");

	let closing: Promise<void> | null = null;
	return {
		ports,
		deps: d,
		close: () => {
			closing ??= shutdown({
				lifecycle: d.lifecycle,
				streams: d.streams,
				listeners,
				ops,
				dispose: built.dispose,
				log: d.log,
				...(o.graceMs === undefined ? {} : { graceMs: o.graceMs }),
			});
			return closing;
		},
	};
}
