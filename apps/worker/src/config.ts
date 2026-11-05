import { PgConfigReader } from "@umiak/config";
import type pg from "pg";
import type { Logger } from "pino";
export async function openWorkerConfig(
	pool: pg.Pool,
	databaseUrl: string,
	log: Logger,
) {
	const config = new PgConfigReader({
		pool,
		listen: { databaseUrl },
		onListenError: (err) => log.warn({ err }, "configuration listener lost"),
	});
	try {
		await config.start();
	} catch (error) {
		await config.close();
		throw error;
	}
	return config;
}
