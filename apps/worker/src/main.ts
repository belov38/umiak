// Worker process entry point: `node src/main.ts` (no build step).
// Reads the environment (src/env.ts), builds the real adapters and runs the
// worker until SIGTERM/SIGINT: stop taking jobs, give active ones 60 s
// (S6 §15.2), close the PVE clients, end the pool, exit 0.
import { readFileSync } from "node:fs";
import { StaticConfigReader } from "@sbx/config";
import { KeyRing } from "@sbx/core";
import { createPool } from "@sbx/db";
import { UnavailableAgentPort } from "./adapters/agent-unavailable.ts";
import {
	HttpGatewayPort,
	UnconfiguredGatewayPort,
} from "./adapters/gateway-http.ts";
import { PveInfraRegistry } from "./adapters/pve-infra.ts";
import { parseWorkerEnv, type WorkerEnv } from "./env.ts";
import { errText, processLogger } from "./log.ts";
import { PromMetrics } from "./metrics.ts";
import type { GatewayPort } from "./ports.ts";
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
		process.stderr.write(`sbx-worker: ${errText(err)}\n`);
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
		const config = StaticConfigReader.fromFile(env.configFile);
		const keys = KeyRing.fromFile(env.dataKeysFile);
		let gateway: GatewayPort;
		if (env.gatewayServiceTokenFile !== undefined) {
			gateway = new HttpGatewayPort(pool, {
				serviceToken: readToken(env.gatewayServiceTokenFile),
			});
		} else {
			log.warn(
				"SBX_GATEWAY_SERVICE_TOKEN_FILE is not set: token rotation fails (transient) until it is",
			);
			gateway = new UnconfiguredGatewayPort();
		}
		worker = createWorker({
			pool,
			config,
			keys,
			infra: new PveInfraRegistry(pool, { secretsDir: env.secretsDir }),
			agent: new UnavailableAgentPort(),
			gateway,
			log,
			metrics: new PromMetrics({ log, defaultMetrics: true }),
			reconcileDryRun: env.reconcileDryRun,
			migrateOnStart: env.migrateOnStart,
			httpPort: env.httpPort,
			idpSyncIntervalMs: env.idpSyncIntervalMs,
		});
		await worker.start();
	} catch (err) {
		log.fatal({ err: errText(err) }, "worker failed to start");
		await worker?.stop({ graceful: false }).catch(() => {});
		await pool.end().catch(() => {});
		process.exit(1);
	}
}

await main();
