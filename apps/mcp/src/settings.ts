// Environment of the remote MCP server (S11 16.3), validated once at start.
// An invalid environment is a fatal error that lists every problem.
import { ownerCidrSet, parseAuthMode } from "@umiak/auth";
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
	ownerEnv?: Record<string, string | undefined>;
	/** UMIAK_MCP_PORT: /mcp, metadata, /healthz, /readyz. */
	port: number;
	/** UMIAK_MCP_OPS_PORT: /metrics, /healthz, /readyz. */
	opsPort: number;
	/** UMIAK_MCP_API_URL: the api's public listener, without a trailing slash. */
	apiUrl: string;
	/** UMIAK_MCP_PUBLIC_URL: the URL clients use, e.g. https://api.example.com/mcp. */
	publicUrl: string;
	/** UMIAK_OIDC_ISSUER without a trailing slash; null: no authorization server. */
	issuer: string | null;
	allowedOrigins: string[];
	allowedHosts: string[];
	logLevel: (typeof LOG_LEVELS)[number];
}

// Empty strings count as unset (compose files often pass `VAR=`).
const unsetEmpty = (v: unknown) => (v === "" ? undefined : v);

function isHttpUrl(v: string): boolean {
	try {
		return ["http:", "https:"].includes(new URL(v).protocol);
	} catch {
		return false;
	}
}

const url = (what: string) =>
	z.preprocess(
		unsetEmpty,
		z
			.string({
				error: (iss) =>
					iss.input === undefined ? `required (${what})` : "must be a string",
			})
			.refine(isHttpUrl, { message: "must be an http:// or https:// URL" }),
	);

const optionalUrl = z.preprocess(
	unsetEmpty,
	z
		.string()
		.refine(isHttpUrl, { message: "must be an http:// or https:// URL" })
		.optional(),
);

const port = (dflt: number) =>
	z.preprocess(
		unsetEmpty,
		z.coerce
			.number({ error: () => "must be an integer" })
			.int({ error: () => "must be an integer" })
			.min(0)
			.max(65535)
			.default(dflt),
	);

const csv = z.preprocess(
	unsetEmpty,
	z
		.string()
		.optional()
		.transform((v) =>
			(v ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s !== ""),
		),
);

const origins = csv.pipe(
	z.array(
		z.string().refine((v) => isHttpUrl(v) && new URL(v).origin === v, {
			message: "must be origins like https://app.example.com (no path)",
		}),
	),
);

const schema = z.object({
	UMIAK_MCP_PORT: port(8080),
	UMIAK_MCP_OPS_PORT: port(9090),
	UMIAK_API_URL: optionalUrl,
	UMIAK_MCP_API_URL: url("the api's public listener, e.g. http://api:8080"),
	UMIAK_MCP_PUBLIC_URL: url("e.g. https://api.example.com/mcp"),
	UMIAK_OIDC_ISSUER: optionalUrl,
	UMIAK_MCP_ALLOWED_ORIGINS: origins,
	UMIAK_MCP_ALLOWED_HOSTS: csv,
	UMIAK_LOG_LEVEL: z.preprocess(unsetEmpty, z.enum(LOG_LEVELS).default("info")),
});

/** Validates the environment; throws SettingsError listing every problem. */
export function loadSettings(
	env: Record<string, string | undefined>,
): Settings {
	const mode = parseAuthMode(env);
	const cidrs = mode === "owner" ? ownerCidrSet(env) : undefined;
	const r = schema.safeParse(env);
	if (!r.success) {
		const lines = r.error.issues.map(
			(i) => `  ${i.path.join(".")}: ${i.message}`,
		);
		throw new SettingsError(`invalid environment:\n${lines.join("\n")}`);
	}
	const e = r.data;
	return {
		...(mode === "owner" && cidrs !== undefined
			? {
					ownerEnv: {
						UMIAK_AUTH_MODE: "owner",
						UMIAK_API_URL: e.UMIAK_API_URL,
						UMIAK_LOCAL_DENIED_CIDRS: cidrs.denied.join(","),
						UMIAK_LOCAL_ALLOWED_CIDRS: cidrs.allowed.join(","),
						UMIAK_API_TRUSTED_PROXY_CIDRS: env.UMIAK_API_TRUSTED_PROXY_CIDRS,
					},
				}
			: {}),
		port: e.UMIAK_MCP_PORT,
		opsPort: e.UMIAK_MCP_OPS_PORT,
		apiUrl: e.UMIAK_MCP_API_URL.replace(/\/+$/, ""),
		publicUrl: e.UMIAK_MCP_PUBLIC_URL,
		issuer:
			mode === "owner"
				? null
				: (e.UMIAK_OIDC_ISSUER?.replace(/\/+$/, "") ?? null),
		allowedOrigins: e.UMIAK_MCP_ALLOWED_ORIGINS,
		allowedHosts: e.UMIAK_MCP_ALLOWED_HOSTS,
		logLevel: e.UMIAK_LOG_LEVEL,
	};
}
