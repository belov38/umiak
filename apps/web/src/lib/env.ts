// Environment of web (S8 §14.1). Parsed once; every problem is reported at
// once, so a misconfigured deployment is fixed in one round.
import { type AuthMode, ownerCidrSet, parseAuthMode } from "@umiak/auth";
import { z } from "zod";

export interface WebEnv {
	authMode: AuthMode;
	/** CIDRs of the trusted ingress in `owner` mode. */
	localAllowedCidrs?: string;
	/** Effective deny list in `owner` mode (explicit list plus node IPs). */
	localDeniedCidrs?: string;
	databaseUrl: string;
	payloadSecret: string;
	/** Origin of the dashboard, the only Origin of unsafe requests (S8 §5.6). */
	appOrigin: string;
	operatorGroups: string[];
	/** Sandbox preview origin configuration, including the CSP frame-src. */
	umiakDomain: string;
	previewScheme: "http" | "https";
	previewPort: number;
	/** Public API URL shown in the UI (CLI and SDK hints). */
	apiPublicUrl: string;
	/** Sign-out target after oauth2-proxy (Keycloak logout); optional. */
	logoutUrl: string | null;
}

const HOSTNAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const httpUrl = z
	.string()
	.trim()
	.refine((v) => {
		try {
			const u = new URL(v);
			return u.protocol === "http:" || u.protocol === "https:";
		} catch {
			return false;
		}
	}, "must be an http(s) URL");

const schema = z.object({
	DATABASE_URL: z
		.string()
		.trim()
		.regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
	PAYLOAD_SECRET: z.string().min(16, "must be at least 16 characters"),
	UMIAK_APP_ORIGIN: httpUrl.refine((v) => {
		try {
			return new URL(v).origin === v;
		} catch {
			return false;
		}
	}, "must be an origin: scheme://host[:port] without a path or trailing slash"),
	UMIAK_OPERATOR_GROUPS: z.string().trim().min(1, "required (comma-separated)"),
	UMIAK_PREVIEW_DOMAIN: z
		.string()
		.trim()
		.toLowerCase()
		.regex(HOSTNAME, "must be a domain name, e.g. umiak.example.com"),
	UMIAK_API_PUBLIC_URL: httpUrl,
	UMIAK_PREVIEW_SCHEME: z.enum(["http", "https"]).default("https"),
	UMIAK_PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).optional(),
	UMIAK_LOGOUT_URL: httpUrl.optional(),
});

export class WebEnvError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`invalid environment:\n  ${issues.join("\n  ")}`);
		this.name = "WebEnvError";
		this.issues = issues;
	}
}

function emptyToUndefined(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) out[k] = v === "" ? undefined : v;
	return out;
}

/** Parses the environment; throws WebEnvError listing every problem. */
export function parseWebEnv(env: Record<string, string | undefined>): WebEnv {
	const r = schema.safeParse(emptyToUndefined(env));
	if (!r.success) {
		throw new WebEnvError(
			r.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`),
		);
	}
	const e = r.data;
	const mode = parseAuthMode(env);
	const cidrs = mode === "owner" ? ownerCidrSet(env) : undefined;
	return {
		authMode: mode,
		...(cidrs === undefined
			? {}
			: {
					localAllowedCidrs: cidrs.allowed.join(","),
					localDeniedCidrs: cidrs.denied.join(","),
				}),
		databaseUrl: e.DATABASE_URL,
		payloadSecret: e.PAYLOAD_SECRET,
		appOrigin: e.UMIAK_APP_ORIGIN,
		operatorGroups: [
			...new Set(
				e.UMIAK_OPERATOR_GROUPS.split(",")
					.map((g) => g.trim())
					.filter((g) => g !== ""),
			),
		],
		umiakDomain: e.UMIAK_PREVIEW_DOMAIN,
		previewScheme: e.UMIAK_PREVIEW_SCHEME,
		previewPort:
			e.UMIAK_PREVIEW_PORT ?? (e.UMIAK_PREVIEW_SCHEME === "http" ? 80 : 443),
		apiPublicUrl: e.UMIAK_API_PUBLIC_URL.replace(/\/+$/, ""),
		logoutUrl: mode === "owner" ? null : (e.UMIAK_LOGOUT_URL ?? null),
	};
}

/**
 * `next build` evaluates route modules without the runtime environment;
 * the config built then is never used to serve requests.
 */
export function isNextBuild(): boolean {
	return process.env.NEXT_PHASE === "phase-production-build";
}

const BUILD_ENV: WebEnv = {
	authMode: "oidc",
	databaseUrl: "postgres://build.invalid/build",
	payloadSecret: "build-time-placeholder-secret",
	appOrigin: "https://app.build.invalid",
	operatorGroups: [],
	umiakDomain: "umiak.build.invalid",
	previewScheme: "https",
	previewPort: 443,
	apiPublicUrl: "https://api.build.invalid",
	logoutUrl: null,
};

let cached: WebEnv | null = null;

/** The environment of this process (placeholders during `next build`). */
export function webEnv(): WebEnv {
	if (isNextBuild()) return BUILD_ENV;
	cached ??= parseWebEnv(process.env);
	return cached;
}
