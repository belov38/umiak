#!/usr/bin/env node
// sbx-admin entry point: `node apps/worker/src/admin/main.ts <command>`.
// Results are JSON lines on stdout, errors a JSON line on stderr, logs go to
// stderr. Exit code 0 on success, 1 on error.
import { StaticConfigReader } from "@sbx/config";
import { ensureQueues, KeyRing, PgBossJobSender } from "@sbx/core";
import { createPool } from "@sbx/db";
import type { PgBoss } from "pg-boss";
import { pino } from "pino";
import { PveInfraRegistry } from "../adapters/pve-infra.ts";
import { createBoss, poolDb } from "../boss.ts";
import { createLogger } from "../context.ts";
import { type AdminEnv, parseAdminEnv } from "../env.ts";
import { errText } from "../log.ts";
import { type AdminDeps, runAdmin } from "./commands.ts";

const line = (stream: NodeJS.WriteStream, o: Record<string, unknown>) =>
	stream.write(`${JSON.stringify(o)}\n`);

async function main(): Promise<number> {
	let env: AdminEnv;
	try {
		env = parseAdminEnv();
	} catch (err) {
		line(process.stderr, { error: errText(err) });
		return 1;
	}
	const log = createLogger(
		{ level: env.logLevel, name: "sbx-admin" },
		pino.destination(2),
	);
	const pool = createPool(env.databaseUrl, 4, {
		onError: (err) => log.error({ err: err.message }, "postgres pool error"),
	});
	let boss: PgBoss | undefined;
	let registry: PveInfraRegistry | undefined;
	const { configFile, dataKeysFile, secretsDir } = env;
	const deps: AdminDeps = {
		pool,
		out: (o) => line(process.stdout, o),
		err: (o) => line(process.stderr, o),
		log,
		jobs: async () => {
			if (!boss) {
				// Send-only: no supervision, cron or registry from the CLI.
				boss = createBoss(poolDb(pool), log, {
					supervise: false,
					schedule: false,
					registerInstance: false,
				});
				await boss.start();
				await ensureQueues(boss);
			}
			return new PgBossJobSender(boss);
		},
		...(configFile !== undefined
			? { config: () => StaticConfigReader.fromFile(configFile) }
			: {}),
		...(dataKeysFile !== undefined
			? { keys: () => KeyRing.fromFile(dataKeysFile) }
			: {}),
		...(secretsDir !== undefined
			? {
					infra: () => {
						registry ??= new PveInfraRegistry(pool, { secretsDir });
						return registry;
					},
				}
			: {}),
	};
	try {
		return await runAdmin(process.argv.slice(2), deps);
	} finally {
		await boss?.stop({ graceful: false }).catch(() => {});
		await registry?.close().catch(() => {});
		await pool.end().catch(() => {});
	}
}

process.exitCode = await main();
