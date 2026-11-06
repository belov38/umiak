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

const workerSchema = z.object({
	UMIAK_AUTH_MODE: z.preprocess(unsetEmpty, z.enum(["owner"]).default("owner")),
	DATABASE_URL: databaseUrl,
	// Templates, sizes, quotas and defaults come from Payload (S8 plan
	// decision 5); UMIAK_CONFIG_FILE is read only by `umiak-admin bootstrap`.
	UMIAK_DATA_KEYS_FILE: required("path of the data key ring JSON"),
	UMIAK_SECRETS_DIR: required("directory with the PVE and umiak-node secrets"),
	UMIAK_GATEWAY_SERVICE_TOKEN_FILE: optional,
	UMIAK_RECONCILE_DRY_RUN: bool(true),
	UMIAK_HTTP_PORT: int(9090, 0, 65535),
	UMIAK_MIGRATE_ON_START: bool(true),
	UMIAK_LOG_LEVEL: logLevel,
	UMIAK_DB_POOL_MAX: int(30, 2, 1000),
	UMIAK_PORT_DOMAIN: optional,
	UMIAK_API_URL: z.preprocess(
		unsetEmpty,
		z
			.url()
			.refine((v) => {
				const u = new URL(v);
				return (
					["http:", "https:"].includes(u.protocol) && !u.username && !u.password
				);
			}, "must be a public HTTP(S) API URL")
			.optional(),
	),
	UMIAK_SSH_USER_CA_KEYS_FILE: optional,
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
	publicApiUrl?: string;
	databaseUrl: string;
	dataKeysFile: string;
	secretsDir: string;
	gatewayServiceTokenFile: string | undefined;
	reconcileDryRun: boolean;
	httpPort: number;
	migrateOnStart: boolean;
	logLevel: (typeof LOG_LEVELS)[number];
	dbPoolMax: number;
	/** Domain of the published ports (`<port>-<sandbox>.<domain>`), sent on every Claim. */
	portDomain: string | undefined;
	/** File with the SSH user CA public keys (one per line), sent on every Claim. */
	sshUserCaKeysFile: string | undefined;
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
		databaseUrl: e.DATABASE_URL,
		dataKeysFile: e.UMIAK_DATA_KEYS_FILE,
		secretsDir: e.UMIAK_SECRETS_DIR,
		gatewayServiceTokenFile: e.UMIAK_GATEWAY_SERVICE_TOKEN_FILE,
		reconcileDryRun: e.UMIAK_RECONCILE_DRY_RUN,
		httpPort: e.UMIAK_HTTP_PORT,
		migrateOnStart: e.UMIAK_MIGRATE_ON_START,
		logLevel: e.UMIAK_LOG_LEVEL,
		dbPoolMax: e.UMIAK_DB_POOL_MAX,
		portDomain: e.UMIAK_PORT_DOMAIN,
		...(e.UMIAK_API_URL
			? { publicApiUrl: e.UMIAK_API_URL.replace(/\/+$/, "") }
			: {}),
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
