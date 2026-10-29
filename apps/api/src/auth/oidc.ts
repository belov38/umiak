// Keycloak access token verification (S7 §7.10): signature by the realm's
// JWKS (discovery -> jwks_uri, or SBX_OIDC_JWKS_URL), RS256/ES256 only, iss,
// aud, exp/nbf/iat with 60 s tolerance, then typ "Bearer", azp in the allowed
// clients and email_verified. No introspection per request.
import {
	createLocalJWKSet,
	createRemoteJWKSet,
	errors,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import { ApiError } from "../http/errors.ts";
import type { OidcSettings } from "../settings.ts";
import { invalidToken } from "./principal.ts";

/** Claims the api uses, already checked. */
export interface OidcClaims {
	sub: string;
	email: string;
	groups: string[];
	preferredUsername: string | undefined;
	name: string | undefined;
	expiresAt: Date;
}

export interface OidcVerifierOptions {
	/** Minimum time between JWKS fetches for an unknown kid (default 30 s). */
	jwksCooldownMs?: number;
	/** JWKS refresh period (default 10 min). */
	jwksMaxAgeMs?: number;
	/** Timeout of discovery and JWKS requests (default 5 s). */
	timeoutMs?: number;
}

const ALGORITHMS = ["RS256", "ES256"];
const CLOCK_TOLERANCE_S = 60;

function idpUnavailable(cause: unknown): ApiError {
	return new ApiError(
		503,
		"idp_unavailable",
		"the identity provider (Keycloak) cannot be reached to verify the token; retry later",
		{ retryable: true, cause },
	);
}

/** Network-level failures of fetching discovery or keys (not token errors). */
function isFetchFailure(e: unknown): boolean {
	return (
		e instanceof errors.JWKSTimeout ||
		(e instanceof Error && !(e instanceof errors.JOSEError))
	);
}

export class OidcVerifier {
	readonly #s: OidcSettings;
	readonly #o: Required<OidcVerifierOptions>;
	#jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
	#jwksPending: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

	constructor(s: OidcSettings, o: OidcVerifierOptions = {}) {
		this.#s = s;
		this.#o = {
			jwksCooldownMs: o.jwksCooldownMs ?? 30_000,
			jwksMaxAgeMs: o.jwksMaxAgeMs ?? 600_000,
			timeoutMs: o.timeoutMs ?? 5_000,
		};
	}

	/** Verifies an access token; throws ApiError 401 (or 503 when Keycloak is unreachable). */
	async verify(token: string): Promise<OidcClaims> {
		const jwks = await this.#keySet();
		let payload: JWTPayload;
		try {
			payload = await this.#jwtVerify(token, jwks);
		} catch (e) {
			// Keycloak is down and the cached keys are stale: keep verifying
			// offline with the last keys we have (S7 §7.10).
			const cached = jwks.jwks();
			if (!isFetchFailure(e) || cached === undefined) throw this.#mapError(e);
			try {
				payload = await this.#jwtVerify(token, createLocalJWKSet(cached));
			} catch (e2) {
				throw this.#mapError(e2);
			}
		}
		return this.#checkClaims(payload);
	}

	async #jwtVerify(token: string, keys: JWTVerifyGetKey): Promise<JWTPayload> {
		const r = await jwtVerify(token, keys, {
			issuer: this.#s.issuer,
			audience: this.#s.audience,
			algorithms: ALGORITHMS,
			clockTolerance: CLOCK_TOLERANCE_S,
			requiredClaims: ["exp"],
		});
		return r.payload;
	}

	#mapError(e: unknown): unknown {
		if (e instanceof ApiError) return e;
		if (e instanceof errors.JWTExpired) {
			return invalidToken(
				"the access token has expired; refresh it and retry",
				"token_expired",
			);
		}
		if (isFetchFailure(e)) return idpUnavailable(e);
		return invalidToken("the access token is not valid");
	}

	#checkClaims(p: JWTPayload): OidcClaims {
		const bad = (what: string) =>
			invalidToken(`the access token is not valid: ${what}`);
		// ID and refresh tokens of Keycloak carry typ "ID" / "Refresh".
		if (p.typ !== "Bearer") throw bad("not an access token");
		if (typeof p.azp !== "string" || !this.#s.allowedClients.includes(p.azp)) {
			throw bad("issued to a client that may not call the API");
		}
		if (p.email_verified !== true) throw bad("the email is not verified");
		if (typeof p.sub !== "string" || p.sub.trim() === "") {
			throw bad("no subject");
		}
		if (typeof p.email !== "string" || p.email.trim() === "") {
			throw bad("no email");
		}
		const groups = Array.isArray(p.groups)
			? p.groups.filter((g): g is string => typeof g === "string")
			: [];
		const str = (v: unknown) =>
			typeof v === "string" && v !== "" ? v : undefined;
		return {
			sub: p.sub,
			email: p.email,
			groups,
			preferredUsername: str(p.preferred_username),
			name: str(p.name),
			expiresAt: new Date((p.exp as number) * 1000),
		};
	}

	/** Remote key set from the discovery document, created once. */
	async #keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
		if (this.#jwks !== null) return this.#jwks;
		this.#jwksPending ??= this.#discover().finally(() => {
			this.#jwksPending = null;
		});
		return this.#jwksPending;
	}

	async #discover(): Promise<ReturnType<typeof createRemoteJWKSet>> {
		let url = this.#s.jwksUrl;
		if (url === null) {
			let doc: unknown;
			try {
				const res = await fetch(this.#s.discoveryUrl, {
					signal: AbortSignal.timeout(this.#o.timeoutMs),
					headers: { accept: "application/json" },
				});
				if (!res.ok) throw new Error(`discovery answered ${res.status}`);
				doc = await res.json();
			} catch (e) {
				throw idpUnavailable(e);
			}
			const uri = (doc as { jwks_uri?: unknown } | null)?.jwks_uri;
			if (typeof uri !== "string") {
				throw idpUnavailable(new Error("discovery has no jwks_uri"));
			}
			url = uri;
		}
		this.#jwks = createRemoteJWKSet(new URL(url), {
			cooldownDuration: this.#o.jwksCooldownMs,
			cacheMaxAge: this.#o.jwksMaxAgeMs,
			timeoutDuration: this.#o.timeoutMs,
		});
		return this.#jwks;
	}
}
