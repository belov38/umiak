// Environment of the worker process and of umiak-admin, validated once at
// start. An invalid environment is a fatal error that lists every problem.
import { z } from "zod";

export class EnvError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EnvError";
	}
}

export const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
] as const;

type Env = Record<string, string | undefined>;

// Empty strings count as unset (compose files often pass `VAR=`).
const unsetEmpty = (v: unknown) => (v === "" ? undefined : v);

const required = (what: string) =>
	z.preprocess(
		unsetEmpty,
		z.string({
			error: (iss) =>
				iss.input === undefined ? `required (${what})` : "must be a string",
		}),
	);

const optional = z.preprocess(unsetEmpty, z.string().optional());

const databaseUrl = required("postgres connection string").refine(
	(v) => {
		try {
			const u = new URL(v);
			return u.protocol === "postgres:" || u.protocol === "postgresql:";
		} catch {
			return false;
		}
	},
	{ message: "must be a postgres:// or postgresql:// URL" },
);

const bool = (dflt: boolean) =>
	z.preprocess(
		unsetEmpty,
		z
			.enum(["1", "0", "true", "false", "yes", "no"], {
				error: () => "must be 1/0, true/false or yes/no",
			})
			.default(dflt ? "1" : "0")
			.transform((v) => v === "1" || v === "true" || v === "yes"),
	);

const int = (dflt: number, min: number, max: number) =>
	z.preprocess(
		unsetEmpty,
		z.coerce
			.number({ error: () => "must be an integer" })
			.int({ error: () => "must be an integer" })
			.min(min)
			.max(max)
			.default(dflt),
	);

const logLevel = z.preprocess(
	unsetEmpty,
	z
		.enum(LOG_LEVELS, {
			error: () => `must be one of ${LOG_LEVELS.join(", ")}`,
		})
		.default("info"),
);

const optionalHttpUrl = z.preprocess(
	unsetEmpty,
	z
		.string()
		.refine(
			(v) => {
				try {
					const u = new URL(v);
					return u.protocol === "http:" || u.protocol === "https:";
				} catch {
					return false;
				}
			},
			{ message: "must be an http:// or https:// URL" },
		)
		.optional(),
);

const workerSchema = z
	.object({
		UMIAK_AUTH_MODE: z.preprocess(
			unsetEmpty,
			z.enum(["oidc", "none"]).default("oidc"),
		),
		DATABASE_URL: databaseUrl,
		// Templates, sizes, quotas and defaults come from Payload (S8 plan
		// decision 5); UMIAK_CONFIG_FILE is read only by `umiak-admin bootstrap`.
		PAYLOAD_SECRET: required("secret of the Payload config, as web"),
		UMIAK_DATA_KEYS_FILE: required("path of the data key ring JSON"),
		UMIAK_SECRETS_DIR: required(
			"directory with the PVE and umiak-node secrets",
		),
		UMIAK_GATEWAY_SERVICE_TOKEN_FILE: optional,
		UMIAK_RECONCILE_DRY_RUN: bool(true),
		UMIAK_HTTP_PORT: int(9090, 0, 65535),
		UMIAK_MIGRATE_ON_START: bool(true),
		UMIAK_LOG_LEVEL: logLevel,
		UMIAK_DB_POOL_MAX: int(30, 2, 1000),
		UMIAK_IDP_SYNC_INTERVAL: int(300, 10, 86_400),
		// ctl-idp-sync (S8 §20.1, plan decision 9): on when the URL is set.
		UMIAK_IDP_SYNC_KEYCLOAK_URL: optionalHttpUrl,
		UMIAK_IDP_SYNC_REALM: z.preprocess(unsetEmpty, z.string().default("umiak")),
		UMIAK_IDP_SYNC_CLIENT_ID: z.preprocess(
			unsetEmpty,
			z.string().default("umiak-worker"),
		),
		UMIAK_IDP_SYNC_CLIENT_SECRET_FILE: optional,
		UMIAK_TURN_SECRET_FILE: optional,
		UMIAK_TURN_URLS: optional,
		UMIAK_PORT_DOMAIN: optional,
		UMIAK_SSH_USER_CA_KEYS_FILE: optional,
	})
	.superRefine((e, ctx) => {
		if (
			e.UMIAK_AUTH_MODE !== "none" &&
			e.UMIAK_IDP_SYNC_KEYCLOAK_URL !== undefined &&
			e.UMIAK_IDP_SYNC_CLIENT_SECRET_FILE === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: ["UMIAK_IDP_SYNC_CLIENT_SECRET_FILE"],
				message:
					"required with UMIAK_IDP_SYNC_KEYCLOAK_URL (client secret file)",
			});
		}
	});

const optionalHttpsUrl = z.preprocess(
	unsetEmpty,
	z
		.string()
		.refine(
			(v) => {
				try {
					return new URL(v).protocol === "https:";
				} catch {
					return false;
				}
			},
			{ message: "must be an https:// URL" },
		)
		.optional(),
);

const adminSchema = z.object({
	DATABASE_URL: databaseUrl,
	UMIAK_CONFIG_FILE: optional,
	UMIAK_DATA_KEYS_FILE: optional,
	UMIAK_SECRETS_DIR: optional,
	UMIAK_PVE_URL: optionalHttpsUrl,
	UMIAK_PVE_TLS_NAME: optional,
	UMIAK_LOG_LEVEL: logLevel,
});

export interface WorkerEnv {
	turnSecretFile: string | undefined;
	turnUrls: string | undefined;
	databaseUrl: string;
	/** PAYLOAD_SECRET: the Payload instance of the config reader. */
	payloadSecret: string;
	dataKeysFile: string;
	secretsDir: string;
	gatewayServiceTokenFile: string | undefined;
	reconcileDryRun: boolean;
	httpPort: number;
	migrateOnStart: boolean;
	logLevel: (typeof LOG_LEVELS)[number];
	dbPoolMax: number;
	idpSyncIntervalMs: number;
	/** Keycloak of ctl-idp-sync; undefined = the controller is off. */
	idpSync: IdpSyncEnv | undefined;
	/** Domain of the published ports (`<port>-<sandbox>.<domain>`), sent on every Claim. */
	portDomain: string | undefined;
	/** File with the SSH user CA public keys (one per line), sent on every Claim. */
	sshUserCaKeysFile: string | undefined;
}

/** Keycloak Admin API access of ctl-idp-sync (S8 §20.1). */
export interface IdpSyncEnv {
	/** UMIAK_IDP_SYNC_KEYCLOAK_URL: internal Keycloak address, without `/realms`. */
	keycloakUrl: string;
	/** UMIAK_IDP_SYNC_REALM (default `umiak`). */
	realm: string;
	/** UMIAK_IDP_SYNC_CLIENT_ID (default `umiak-worker`). */
	clientId: string;
	/** UMIAK_IDP_SYNC_CLIENT_SECRET_FILE: file with the client secret. */
	clientSecretFile: string;
}

/**
 * Replaces `apiUrl` / `tlsName` of the first topology provider in
 * `umiak-admin bootstrap` (UMIAK_PVE_URL / UMIAK_PVE_TLS_NAME): the YAML has no
 * interpolation, and the PVE address differs between deployments.
 */
export interface ProviderOverride {
	apiUrl?: string;
	tlsName?: string;
}

export interface AdminEnv {
	databaseUrl: string;
	configFile: string | undefined;
	dataKeysFile: string | undefined;
	secretsDir: string | undefined;
	providerOverride: ProviderOverride;
	logLevel: (typeof LOG_LEVELS)[number];
}

function fail(err: z.ZodError): never {
	const lines = err.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
	throw new EnvError(`invalid environment:\n${lines.join("\n")}`);
}

export function parseWorkerEnv(env: Env = process.env): WorkerEnv {
	const r = workerSchema.safeParse(env);
	if (!r.success) fail(r.error);
	const e = r.data;
	return {
		turnSecretFile: e.UMIAK_TURN_SECRET_FILE,
		turnUrls: e.UMIAK_TURN_URLS,
		databaseUrl: e.DATABASE_URL,
		payloadSecret: e.PAYLOAD_SECRET,
		dataKeysFile: e.UMIAK_DATA_KEYS_FILE,
		secretsDir: e.UMIAK_SECRETS_DIR,
		gatewayServiceTokenFile: e.UMIAK_GATEWAY_SERVICE_TOKEN_FILE,
		reconcileDryRun: e.UMIAK_RECONCILE_DRY_RUN,
		httpPort: e.UMIAK_HTTP_PORT,
		migrateOnStart: e.UMIAK_MIGRATE_ON_START,
		logLevel: e.UMIAK_LOG_LEVEL,
		dbPoolMax: e.UMIAK_DB_POOL_MAX,
		idpSyncIntervalMs: e.UMIAK_IDP_SYNC_INTERVAL * 1000,
		idpSync:
			e.UMIAK_AUTH_MODE === "none" ||
			e.UMIAK_IDP_SYNC_KEYCLOAK_URL === undefined ||
			e.UMIAK_IDP_SYNC_CLIENT_SECRET_FILE === undefined
				? undefined
				: {
						keycloakUrl: e.UMIAK_IDP_SYNC_KEYCLOAK_URL,
						realm: e.UMIAK_IDP_SYNC_REALM,
						clientId: e.UMIAK_IDP_SYNC_CLIENT_ID,
						clientSecretFile: e.UMIAK_IDP_SYNC_CLIENT_SECRET_FILE,
					},
		portDomain: e.UMIAK_PORT_DOMAIN,
		sshUserCaKeysFile: e.UMIAK_SSH_USER_CA_KEYS_FILE,
	};
}

export function parseAdminEnv(env: Env = process.env): AdminEnv {
	const r = adminSchema.safeParse(env);
	if (!r.success) fail(r.error);
	const e = r.data;
	return {
		databaseUrl: e.DATABASE_URL,
		configFile: e.UMIAK_CONFIG_FILE,
		dataKeysFile: e.UMIAK_DATA_KEYS_FILE,
		secretsDir: e.UMIAK_SECRETS_DIR,
		providerOverride: {
			...(e.UMIAK_PVE_URL === undefined ? {} : { apiUrl: e.UMIAK_PVE_URL }),
			...(e.UMIAK_PVE_TLS_NAME === undefined
				? {}
				: { tlsName: e.UMIAK_PVE_TLS_NAME }),
		},
		logLevel: e.UMIAK_LOG_LEVEL,
	};
}
