// Worker process entry point: `node src/main.ts` (type stripping, no build of
// the worker itself).
// Reads the environment (src/env.ts), builds the real adapters and runs the
// worker until SIGTERM/SIGINT: stop taking jobs, give active ones 60 s
// (S6 §15.2), close the PVE clients, the S2 registry, Payload and the pool,
// exit 0. Templates, sizes, quotas and defaults come from Payload
// (src/payload.ts); its migrations are applied by the web-migrate job.
// `@umiak/agent-client` and `@umiak/proto` are loaded from their `dist`: run
// `pnpm build` once before `node src/main.ts` (the image does it).
import { readFileSync } from "node:fs";
import { AgentClient, PgRegistry } from "@umiak/agent-client";
import { KeyRing } from "@umiak/core";
import { createPool } from "@umiak/db";
import { ConnectAgentPort, parseCaKeys } from "./adapters/agent-connect.ts";
import { UnavailableAgentPort } from "./adapters/agent-unavailable.ts";
import {
	HttpGatewayPort,
	UnconfiguredGatewayPort,
} from "./adapters/gateway-http.ts";
import { PveInfraRegistry } from "./adapters/pve-infra.ts";
import { parseWorkerEnv, type WorkerEnv } from "./env.ts";
import { errText, processLogger } from "./log.ts";
import { PromMetrics } from "./metrics.ts";
import { openWorkerPayload, type WorkerPayload } from "./payload.ts";
import type { AgentPort, GatewayPort } from "./ports.ts";
import { createWorker, STOP_TIMEOUT_MS, type Worker } from "./worker.ts";

function readToken(path: string): string {
	const token = readFileSync(path, "utf8").trim();
	if (token === "")
		throw new Error(`gateway service token file ${path} is empty`);
	return token;
}

async function main(): Promise<void> {
	let env: WorkerEnv;
	try {
		env = parseWorkerEnv();
	} catch (err) {
		process.stderr.write(`umiak-worker: ${errText(err)}\n`);
		process.exit(1);
	}
	const log = processLogger(env.logLevel);
	const pool = createPool(env.databaseUrl, env.dbPoolMax, {
		onError: (err) =>
			log.error({ err: err.message }, "postgres pool: idle client error"),
	});
	process.on("unhandledRejection", (reason) => {
		log.error({ err: errText(reason) }, "unhandled rejection");
	});

	let worker: Worker | undefined;
	// S2 registry for routing rotate-token; its own small pool and LISTEN connection.
	let registry: PgRegistry | undefined;
	// Agent RPC client over the same registry; closed before it.
	let agentClient: AgentClient | undefined;
	// Payload instance of the config reader; its own pool and LISTEN connection.
	let payload: WorkerPayload | undefined;
	let exiting = false;
	const shutdown = async (signal: string) => {
		if (exiting) {
			log.warn({ signal }, "second signal: exiting now");
			process.exit(1);
		}
		exiting = true;
		log.info({ signal }, "shutting down");
		try {
			await worker?.stop({ graceful: true, timeoutMs: STOP_TIMEOUT_MS });
			await agentClient?.close();
			await registry?.close();
			await payload?.close();
			await pool.end();
		} catch (err) {
			log.error({ err: errText(err) }, "shutdown failed");
			process.exit(1);
		}
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	try {
		const keys = KeyRing.fromFile(env.dataKeysFile);
		payload = await openWorkerPayload({
			databaseUrl: env.databaseUrl,
			secret: env.payloadSecret,
			log,
		});
		const p = payload;
		let gateway: GatewayPort;
		let agent: AgentPort;
		if (env.gatewayServiceTokenFile !== undefined) {
			const serviceToken = readToken(env.gatewayServiceTokenFile);
			registry = await PgRegistry.connect({
				connectionString: env.databaseUrl,
				maxConnections: 2,
			});
			gateway = new HttpGatewayPort(registry, { serviceToken });
			agentClient = new AgentClient({ registry, serviceToken });
			agent = new ConnectAgentPort(agentClient, {
				log,
				...(env.portDomain === undefined ? {} : { portDomain: env.portDomain }),
				...(env.sshUserCaKeysFile === undefined
					? {}
					: {
							sshUserCaKeys: parseCaKeys(
								readFileSync(env.sshUserCaKeysFile, "utf8"),
							),
						}),
			});
		} else {
			log.warn(
				"UMIAK_GATEWAY_SERVICE_TOKEN_FILE is not set: token rotation and agent calls fail (transient) until it is",
			);
			gateway = new UnconfiguredGatewayPort();
			agent = new UnavailableAgentPort();
		}
		worker = createWorker({
			pool,
			config: p.config,
			keys,
			infra: new PveInfraRegistry(pool, { secretsDir: env.secretsDir }),
			agent,
			gateway,
			log,
			metrics: new PromMetrics({ log, defaultMetrics: true }),
			reconcileDryRun: env.reconcileDryRun,
			migrateOnStart: env.migrateOnStart,
			httpPort: env.httpPort,
			payloadReady: () => p.ready(),
		});
		await worker.start();
	} catch (err) {
		log.fatal({ err: errText(err) }, "worker failed to start");
		await worker?.stop({ graceful: false }).catch(() => {});
		await agentClient?.close().catch(() => {});
		await registry?.close().catch(() => {});
		await payload?.close().catch(() => {});
		await pool.end().catch(() => {});
		process.exit(1);
	}
}

await main();
