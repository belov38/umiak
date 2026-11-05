// Environment of the api process, validated once at start. An invalid
// environment is a fatal error that lists every problem.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
	type AuthMode,
	loadSshCa,
	loadSshHostKeys,
	OWNER_OPERATOR_GROUP,
	ownerAllowedCidrs,
	ownerDeniedCidrs,
	parseAuthMode,
	type SshCa,
} from "@umiak/auth";
import { z } from "zod";

export class SettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsError";
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

export interface Settings {
	authMode: AuthMode;
	localAllowedCidrs: string[];
	localDeniedCidrs?: string[];
	/** Host authorities accepted in owner mode (API and app). */
	ownerHosts: string[];
	publicPort: number;
	proxiedPort: number;
	internalPort: number;
	metricsPort: number;
	/** The proxied listener (owner ingress) is started. */
	proxiedEnabled: boolean;
	databaseUrl: string;
	dataKeysFile: string;
	/** HMAC key of list cursors, at least 32 bytes. */
	cursorKey: Buffer;
	serviceTokensFile: string;
	/**
	 * Token of the api for the gateway internal listener (agent calls); null:
	 * agent calls answer 503 agent_unavailable.
	 */
	gatewayTokenFile: string | null;
	identityFile: string | null;
	operatorGroups: string[];
	/** Origin the proxied listener accepts for unsafe methods and upgrades. */
	appOrigin: string;
	apiUrl: string;
	appUrl: string;
	umiakDomain: string;
	previewScheme: "http" | "https";
	previewPort: number;
	sshHost: string;
	/**
	 * Owner mode: desktop links are `<appOrigin><prefix>/<slug>/` on the owner
	 * origin instead of `<slug>-desktop.<domain>`. Null keeps hostname links.
	 */
	desktopPathPrefix: string | null;
	sshPort: number;
	sshHostKeysFile: string | null;
	sshLoginCaKeyFile: string | null;
	trustedProxyCidrs: string[];
	rate: { rps: number; burst: number; startsPerMinute: number };
	maxStreams: number;
	minCliVersion: string | null;
	latestCliVersion: string | null;
	build: string;
	logLevel: (typeof LOG_LEVELS)[number];
}

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

function isUrl(v: string, protocols: string[]): boolean {
	try {
		return protocols.includes(new URL(v).protocol);
	} catch {
		return false;
	}
}

const url = (what: string, protocols = ["http:", "https:"]) =>
	required(what).refine((v) => isUrl(v, protocols), {
		message: `must be a ${protocols.map((p) => `${p}//`).join(" or ")} URL`,
	});

const optionalUrl = z.preprocess(
	unsetEmpty,
	z
		.string()
		.refine((v) => isUrl(v, ["http:", "https:"]), {
			message: "must be an http:// or https:// URL",
		})
		.optional(),
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

const port = (dflt: number) => int(dflt, 0, 65535);

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

const csv = (dflt: string) =>
	z.preprocess(
		unsetEmpty,
		z
			.string()
			.default(dflt)
			.transform((v) =>
				v
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s !== ""),
			),
	);

function isCidr(v: string): boolean {
	const [addr, prefix, ...rest] = v.split("/");
	if (addr === undefined || prefix === undefined || rest.length > 0) {
		return false;
	}
	const family = isIP(addr);
	if (family === 0 || !/^\d{1,3}$/.test(prefix)) return false;
	return Number(prefix) <= (family === 4 ? 32 : 128);
}

const cidrs = csv("").refine((l) => l.every(isCidr), {
	message: "must be a comma-separated list of CIDRs (10.0.0.0/8,fd00::/8)",
});

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

const cursorKey = required("base64 HMAC key of list cursors, >= 32 bytes")
	.refine((v) => BASE64_RE.test(v), { message: "must be base64" })
	.transform((v) => Buffer.from(v, "base64"))
	.refine((b) => b.length >= 32, {
		message: "must decode to at least 32 bytes",
	});

const VERSION_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/;

const version = z.preprocess(
	unsetEmpty,
	z
		.string()
		.regex(VERSION_RE, { message: "must be a version like 1.2.3" })
		.optional(),
);

const schema = z.object({
	UMIAK_API_PUBLIC_PORT: port(8080),
	UMIAK_API_PROXIED_PORT: port(8081),
	UMIAK_API_INTERNAL_PORT: port(8082),
	UMIAK_API_METRICS_PORT: port(9090),
	UMIAK_API_PROXIED_ENABLED: bool(true),
	DATABASE_URL: url("postgres connection string", ["postgres:", "postgresql:"]),
	UMIAK_DATA_KEYS_FILE: required("path of the data key ring JSON"),
	UMIAK_API_CURSOR_KEY: cursorKey,
	UMIAK_API_SERVICE_TOKENS_FILE: required("path of the service tokens JSON"),
	UMIAK_API_GATEWAY_TOKEN_FILE: optional,
	UMIAK_IDENTITY_FILE: optional,
	UMIAK_APP_ORIGIN: optionalUrl,
	UMIAK_API_URL: url("public URL of the API, https://api.<domain>"),
	UMIAK_APP_URL: url("URL of the dashboard, https://app.<domain>"),
	UMIAK_PREVIEW_DOMAIN: required("domain of sandbox ports, <domain>").refine(
		(v) => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v),
		{ message: "must be a lower-case DNS name" },
	),
	UMIAK_PREVIEW_SCHEME: z.preprocess(
		unsetEmpty,
		z.enum(["http", "https"]).default("https"),
	),
	UMIAK_PREVIEW_PORT: z.preprocess(
		unsetEmpty,
		z.coerce.number().int().min(1).max(65535).optional(),
	),
	UMIAK_SSH_HOST: optional,
	UMIAK_DESKTOP_PATH_PREFIX: z.preprocess(
		unsetEmpty,
		z
			.string()
			.regex(/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*\/?$/, {
				message: "must be an absolute path such as /desktop",
			})
			.optional(),
	),
	UMIAK_SSH_PORT: int(22, 1, 65535),
	UMIAK_SSH_HOST_KEYS_FILE: optional,
	UMIAK_SSH_LOGIN_CA_KEY_FILE: optional,
	UMIAK_API_TRUSTED_PROXY_CIDRS: cidrs,
	UMIAK_API_RATE_RPS: int(20, 1, 1_000_000),
	UMIAK_API_RATE_BURST: int(100, 1, 1_000_000),
	UMIAK_API_RATE_STARTS_PER_MIN: int(30, 1, 1_000_000),
	UMIAK_API_MAX_STREAMS: int(100, 1, 1_000_000),
	UMIAK_MIN_CLI_VERSION: version,
	UMIAK_LATEST_CLI_VERSION: version,
	UMIAK_BUILD: z.preprocess(unsetEmpty, z.string().default("dev")),
	UMIAK_LOG_LEVEL: z.preprocess(
		unsetEmpty,
		z
			.enum(LOG_LEVELS, {
				error: () => `must be one of ${LOG_LEVELS.join(", ")}`,
			})
			.default("info"),
	),
});

/** Validates the environment; throws SettingsError listing every problem. */
export function loadSettings(
	env: Record<string, string | undefined>,
): Settings {
	const mode = parseAuthMode(env);
	const allowed = ownerAllowedCidrs(env);
	const r = schema.safeParse(env);
	const lines = r.success
		? []
		: r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
	if (!r.success || lines.length > 0) {
		throw new SettingsError(`invalid environment:\n${lines.join("\n")}`);
	}
	const e = r.data;
	return {
		authMode: mode,
		localAllowedCidrs: allowed,
		localDeniedCidrs: ownerDeniedCidrs(env),
		ownerHosts: [
			...new Set([
				new URL(e.UMIAK_API_URL).host,
				new URL(e.UMIAK_APP_ORIGIN ?? e.UMIAK_APP_URL).host,
			]),
		],
		publicPort: e.UMIAK_API_PUBLIC_PORT,
		proxiedPort: e.UMIAK_API_PROXIED_PORT,
		internalPort: e.UMIAK_API_INTERNAL_PORT,
		metricsPort: e.UMIAK_API_METRICS_PORT,
		proxiedEnabled: e.UMIAK_API_PROXIED_ENABLED,
		databaseUrl: e.DATABASE_URL,
		dataKeysFile: e.UMIAK_DATA_KEYS_FILE,
		cursorKey: e.UMIAK_API_CURSOR_KEY,
		serviceTokensFile: e.UMIAK_API_SERVICE_TOKENS_FILE,
		gatewayTokenFile: e.UMIAK_API_GATEWAY_TOKEN_FILE ?? null,
		identityFile: e.UMIAK_IDENTITY_FILE ?? null,
		operatorGroups: [OWNER_OPERATOR_GROUP],
		appOrigin: new URL(e.UMIAK_APP_ORIGIN ?? e.UMIAK_APP_URL).origin,
		apiUrl: e.UMIAK_API_URL.replace(/\/+$/, ""),
		appUrl: e.UMIAK_APP_URL.replace(/\/+$/, ""),
		umiakDomain: e.UMIAK_PREVIEW_DOMAIN,
		previewScheme: e.UMIAK_PREVIEW_SCHEME,
		previewPort:
			e.UMIAK_PREVIEW_PORT ?? (e.UMIAK_PREVIEW_SCHEME === "http" ? 80 : 443),
		desktopPathPrefix: e.UMIAK_DESKTOP_PATH_PREFIX?.replace(/\/+$/, "") ?? null,
		sshHost: e.UMIAK_SSH_HOST ?? `ssh.${e.UMIAK_PREVIEW_DOMAIN}`,
		sshPort: e.UMIAK_SSH_PORT,
		sshHostKeysFile: e.UMIAK_SSH_HOST_KEYS_FILE ?? null,
		sshLoginCaKeyFile: e.UMIAK_SSH_LOGIN_CA_KEY_FILE ?? null,
		trustedProxyCidrs: e.UMIAK_API_TRUSTED_PROXY_CIDRS,
		rate: {
			rps: e.UMIAK_API_RATE_RPS,
			burst: e.UMIAK_API_RATE_BURST,
			startsPerMinute: e.UMIAK_API_RATE_STARTS_PER_MIN,
		},
		maxStreams: e.UMIAK_API_MAX_STREAMS,
		minCliVersion: e.UMIAK_MIN_CLI_VERSION ?? null,
		latestCliVersion: e.UMIAK_LATEST_CLI_VERSION ?? null,
		build: e.UMIAK_BUILD,
		logLevel: e.UMIAK_LOG_LEVEL,
	};
}

/**
 * Public host keys of the gateway for `/v1/meta` (UMIAK_SSH_HOST_KEYS_FILE);
 * an empty list without the file. A missing or invalid file is fatal.
 */
export function readHostKeys(file: string | null): string[] {
	return file === null ? [] : loadSshHostKeys(readFileSync(file, "utf8"));
}

/**
 * The SSH login CA (UMIAK_SSH_LOGIN_CA_KEY_FILE: unencrypted ed25519, PKCS#8
 * PEM or OpenSSH); null without the file. A missing or invalid file is fatal.
 */
export function readSshCa(file: string | null): SshCa | null {
	return file === null ? null : loadSshCa(readFileSync(file, "utf8"));
}
