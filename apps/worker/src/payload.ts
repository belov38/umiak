// Payload of the worker (S8 plan decision 5): the config reader over the
// Payload collections (LISTEN umiak_config drops its cache) and the readiness
// check of the Payload migrations. The migrations themselves are applied by
// `node packages/payload/src/migrate.ts` (compose: web-migrate), never here.
import { readFileSync } from "node:fs";
import {
	assertPayloadMigrated,
	closeUmiakPayload,
	getUmiakPayload,
	KeycloakAdminClient,
	KeycloakIdpSync,
	PayloadConfigReader,
} from "@umiak/payload";
import type { Logger } from "pino";
import type { IdpSync } from "./controllers/idp-sync.ts";
import type { IdpSyncEnv } from "./env.ts";
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

export interface WorkerIdpSyncOptions {
	/** `WorkerEnv.idpSync`; undefined = no sync (ctl-idp-sync is not registered). */
	env: IdpSyncEnv | undefined;
	payload: WorkerPayload["payload"];
	log: Logger;
	/** Reads the client secret file (tests). */
	readFile?: (path: string) => string;
}

/**
 * ctl-idp-sync over Keycloak (S8 §20.1), or undefined without
 * UMIAK_IDP_SYNC_KEYCLOAK_URL. The client secret is read once from its file
 * and never logged; aborts are reported through the result (runIdpSync
 * turns them into metrics and log.error).
 */
export function createWorkerIdpSync(
	o: WorkerIdpSyncOptions,
): IdpSync | undefined {
	if (o.env === undefined) return undefined;
	const read = o.readFile ?? ((p: string) => readFileSync(p, "utf8"));
	const clientSecret = read(o.env.clientSecretFile).trim();
	if (clientSecret === "") {
		throw new Error(
			`idp sync client secret file ${o.env.clientSecretFile} is empty`,
		);
	}
	return new KeycloakIdpSync({
		payload: o.payload,
		keycloak: new KeycloakAdminClient({
			baseUrl: o.env.keycloakUrl,
			realm: o.env.realm,
			clientId: o.env.clientId,
			clientSecret,
		}),
		log: o.log,
	});
}
