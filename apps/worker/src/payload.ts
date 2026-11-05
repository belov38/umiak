import {
	assertPayloadMigrated,
	closeUmiakPayload,
	getUmiakPayload,
	PayloadConfigReader,
} from "@umiak/payload";
import type { Logger } from "pino";
import { errText } from "./log.ts";

/**
 * Connections of the Payload adapter pool: the adapter keeps one for good,
 * the config reader reads at most every few seconds (cache, LISTEN).
 */
export const PAYLOAD_POOL_MAX = 4;

export interface WorkerPayloadOptions {
	databaseUrl: string;
	/** PAYLOAD_SECRET. */
	secret: string;
	log: Logger;
}

export interface WorkerPayload {
	payload: Awaited<ReturnType<typeof getUmiakPayload>>;
	config: PayloadConfigReader;
	/** Throws while a Payload migration known to the code is not applied. */
	ready(): Promise<void>;
	/** Stops LISTEN and releases the Payload pool. */
	close(): Promise<void>;
}

/** Opens Payload and starts the config reader (rejects if LISTEN cannot connect). */
export async function openWorkerPayload(
	o: WorkerPayloadOptions,
): Promise<WorkerPayload> {
	const payload = await getUmiakPayload({
		databaseUrl: o.databaseUrl,
		secret: o.secret,
		// The worker authenticates nobody (the strategy is web's and api's).
		operatorGroups: [],
		poolMax: PAYLOAD_POOL_MAX,
	});
	const config = new PayloadConfigReader({
		payload,
		listen: { databaseUrl: o.databaseUrl },
		onListenError: (err) =>
			o.log.warn({ err: errText(err) }, "LISTEN umiak_config: connection lost"),
	});
	try {
		await config.start();
	} catch (err) {
		await config.close().catch(() => {});
		await closeUmiakPayload(o.databaseUrl);
		throw err;
	}
	let closing: Promise<void> | undefined;
	return {
		payload,
		config,
		ready: () => assertPayloadMigrated(payload),
		close: () => {
			closing ??= (async () => {
				await config.close().catch((err: unknown) => {
					o.log.warn({ err: errText(err) }, "closing the config reader failed");
				});
				await closeUmiakPayload(o.databaseUrl);
			})();
			return closing;
		},
	};
}
