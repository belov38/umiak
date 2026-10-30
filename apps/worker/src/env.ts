// Environment of the worker process and of sbx-admin, validated once at
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

const workerSchema = z.object({
	DATABASE_URL: databaseUrl,
	// Templates, sizes, quotas and defaults come from Payload (S8 plan
	// decision 5); SBX_CONFIG_FILE is read only by `sbx-admin bootstrap`.
	PAYLOAD_SECRET: required("secret of the Payload config, as web"),
	SBX_DATA_KEYS_FILE: required("path of the data key ring JSON"),
	SBX_SECRETS_DIR: required("directory with the PVE and sbx-node secrets"),
	SBX_GATEWAY_SERVICE_TOKEN_FILE: optional,
	SBX_RECONCILE_DRY_RUN: bool(true),
	SBX_HTTP_PORT: int(9090, 0, 65535),
	SBX_MIGRATE_ON_START: bool(true),
	SBX_LOG_LEVEL: z.preprocess(
		unsetEmpty,
		z
			.enum(LOG_LEVELS, {
				error: () => `must be one of ${LOG_LEVELS.join(", ")}`,
			})
			.default("info"),
	),
	SBX_DB_POOL_MAX: int(30, 2, 1000),
	SBX_IDP_SYNC_INTERVAL: int(300, 10, 86_400),
	SBX_PORT_DOMAIN: optional,
	SBX_SSH_USER_CA_KEYS_FILE: optional,
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
	SBX_CONFIG_FILE: optional,
	SBX_DATA_KEYS_FILE: optional,
	SBX_SECRETS_DIR: optional,
	SBX_PVE_URL: optionalHttpsUrl,
	SBX_PVE_TLS_NAME: optional,
	SBX_LOG_LEVEL: workerSchema.shape.SBX_LOG_LEVEL,
});

export interface WorkerEnv {
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
	/** Domain of the published ports (`<port>-<sandbox>.<domain>`), sent on every Claim. */
	portDomain: string | undefined;
	/** File with the SSH user CA public keys (one per line), sent on every Claim. */
	sshUserCaKeysFile: string | undefined;
}

/**
 * Replaces `apiUrl` / `tlsName` of the first topology provider in
 * `sbx-admin bootstrap` (SBX_PVE_URL / SBX_PVE_TLS_NAME): the YAML has no
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
		databaseUrl: e.DATABASE_URL,
		payloadSecret: e.PAYLOAD_SECRET,
		dataKeysFile: e.SBX_DATA_KEYS_FILE,
		secretsDir: e.SBX_SECRETS_DIR,
		gatewayServiceTokenFile: e.SBX_GATEWAY_SERVICE_TOKEN_FILE,
		reconcileDryRun: e.SBX_RECONCILE_DRY_RUN,
		httpPort: e.SBX_HTTP_PORT,
		migrateOnStart: e.SBX_MIGRATE_ON_START,
		logLevel: e.SBX_LOG_LEVEL,
		dbPoolMax: e.SBX_DB_POOL_MAX,
		idpSyncIntervalMs: e.SBX_IDP_SYNC_INTERVAL * 1000,
		portDomain: e.SBX_PORT_DOMAIN,
		sshUserCaKeysFile: e.SBX_SSH_USER_CA_KEYS_FILE,
	};
}

export function parseAdminEnv(env: Env = process.env): AdminEnv {
	const r = adminSchema.safeParse(env);
	if (!r.success) fail(r.error);
	const e = r.data;
	return {
		databaseUrl: e.DATABASE_URL,
		configFile: e.SBX_CONFIG_FILE,
		dataKeysFile: e.SBX_DATA_KEYS_FILE,
		secretsDir: e.SBX_SECRETS_DIR,
		providerOverride: {
			...(e.SBX_PVE_URL === undefined ? {} : { apiUrl: e.SBX_PVE_URL }),
			...(e.SBX_PVE_TLS_NAME === undefined
				? {}
				: { tlsName: e.SBX_PVE_TLS_NAME }),
		},
		logLevel: e.SBX_LOG_LEVEL,
	};
}
