// Keycloak access token verification (S7 §7.10): signature by the realm's
// JWKS (discovery -> jwks_uri, or UMIAK_OIDC_JWKS_URL), RS256/ES256 only, iss,
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
	/**
	 * After a failed JWKS fetch, verify offline with the last good keys and
	 * do not try Keycloak again for this long (default 30 s), so a hanging
	 * Keycloak does not cost every request the timeout. Without good keys
	 * yet (cold start) there is no backoff.
	 */
	outageBackoffMs?: number;
	/** After a failed discovery, answer 503 without retrying for this long (default 5 s). */
	discoveryRetryMs?: number;
}

const ALGORITHMS = ["RS256", "ES256"];
const CLOCK_TOLERANCE_S = 60;

type RemoteKeySet = ReturnType<typeof createRemoteJWKSet>;
type KeyArgs = Parameters<JWTVerifyGetKey>;

function idpUnavailable(cause: unknown): ApiError {
	return new ApiError(
		503,
		"idp_unavailable",
		"the identity provider (Keycloak) cannot be reached to verify the token; retry later",
		{ retryable: true, cause },
	);
}

/**
 * A failure to fetch or read the key set (network, timeout, non-200, bad
 * JSON, not a JWKS), as opposed to a token that matches no key.
 */
function isKeySetOutage(e: unknown): boolean {
	if (!(e instanceof errors.JOSEError)) return true;
	return (
		e instanceof errors.JWKSTimeout ||
		e instanceof errors.JWKSInvalid ||
		e.code === "ERR_JOSE_GENERIC"
	);
}

export class OidcVerifier {
	readonly #s: OidcSettings;
	readonly #o: Required<OidcVerifierOptions>;
	#jwks: RemoteKeySet | null = null;
	#jwksPending: Promise<RemoteKeySet> | null = null;
	/** No discovery attempt before this time (ms) after a failure. */
	#discoveryRetryAt = 0;
	/** Keycloak's key set is unreachable: offline until this time (ms). */
	#outageUntil = 0;
	readonly #getKey: JWTVerifyGetKey = (...args) => this.#resolveKey(...args);

	constructor(s: OidcSettings, o: OidcVerifierOptions = {}) {
		this.#s = s;
		this.#o = {
			jwksCooldownMs: o.jwksCooldownMs ?? 30_000,
			jwksMaxAgeMs: o.jwksMaxAgeMs ?? 600_000,
			timeoutMs: o.timeoutMs ?? 5_000,
			outageBackoffMs: o.outageBackoffMs ?? 30_000,
			discoveryRetryMs: o.discoveryRetryMs ?? 5_000,
		};
	}

	/** Verifies an access token; throws ApiError 401 (or 503 when Keycloak is unreachable). */
	async verify(token: string): Promise<OidcClaims> {
		let payload: JWTPayload;
		try {
			payload = (
				await jwtVerify(token, this.#getKey, {
					issuer: this.#s.issuer,
					audience: this.#s.audience,
					algorithms: ALGORITHMS,
					clockTolerance: CLOCK_TOLERANCE_S,
					requiredClaims: ["exp"],
				})
			).payload;
		} catch (e) {
			throw this.#mapError(e);
		}
		return this.#checkClaims(payload);
	}

	/**
	 * Key of a token: from Keycloak's JWKS, or, while Keycloak's key set
	 * cannot be fetched, from the last good set (S7 §7.10: tokens are
	 * verified offline). An unknown kid during an outage is a 503.
	 */
	async #resolveKey(...[header, token]: KeyArgs) {
		const remote = await this.#keySet();
		if (Date.now() < this.#outageUntil)
			return this.#offline(remote, header, token, null);
		try {
			return await remote(header, token);
		} catch (e) {
			if (!isKeySetOutage(e)) throw e;
			// Back off only with keys to verify offline; on a cold start the
			// next request tries Keycloak again instead of 503 for the backoff.
			if (remote.jwks() !== undefined) {
				this.#outageUntil = Date.now() + this.#o.outageBackoffMs;
			}
			return this.#offline(remote, header, token, e);
		}
	}

	async #offline(
		remote: RemoteKeySet,
		header: KeyArgs[0],
		token: KeyArgs[1],
		cause: unknown,
	) {
		// The remote set keeps its last successfully fetched keys.
		const last = remote.jwks();
		if (last === undefined) throw idpUnavailable(cause);
		try {
			return await createLocalJWKSet(last)(header, token);
		} catch (e) {
			if (e instanceof errors.JWKSNoMatchingKey)
				throw idpUnavailable(cause ?? e);
			throw e;
		}
	}

	#mapError(e: unknown): unknown {
		if (e instanceof ApiError) return e;
		if (e instanceof errors.JWTExpired) {
			return invalidToken(
				"the access token has expired; refresh it and retry",
				"token_expired",
			);
		}
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
		// jose checks iat only with maxTokenAge; a token from the future is forged or skewed.
		if (
			typeof p.iat === "number" &&
			p.iat > Date.now() / 1000 + CLOCK_TOLERANCE_S
		) {
			throw bad("issued in the future");
		}
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
	async #keySet(): Promise<RemoteKeySet> {
		if (this.#jwks !== null) return this.#jwks;
		if (this.#jwksPending === null && Date.now() < this.#discoveryRetryAt) {
			throw idpUnavailable(new Error("discovery failed recently"));
		}
		this.#jwksPending ??= this.#discover()
			.catch((e: unknown) => {
				this.#discoveryRetryAt = Date.now() + this.#o.discoveryRetryMs;
				throw e;
			})
			.finally(() => {
				this.#jwksPending = null;
			});
		return this.#jwksPending;
	}

	async #discover(): Promise<RemoteKeySet> {
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
		let jwksUrl: URL;
		try {
			jwksUrl = new URL(url);
		} catch (e) {
			throw idpUnavailable(e);
		}
		this.#jwks = createRemoteJWKSet(jwksUrl, {
			cooldownDuration: this.#o.jwksCooldownMs,
			cacheMaxAge: this.#o.jwksMaxAgeMs,
			timeoutDuration: this.#o.timeoutMs,
		});
		return this.#jwks;
	}
}
