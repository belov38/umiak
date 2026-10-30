// A Keycloak-shaped OIDC server for tests (S7 plan decision 13): realm
// `sbx` with discovery, JWKS, the device authorization grant (RFC 8628),
// refresh and revocation at Keycloak's paths. Tokens are signed with real
// RS256/ES256 keys, so the api verifies them exactly like Keycloak's.
// Used by the api auth tests and later by the CLI and SDK tests.
import {
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	randomUUID,
} from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";

export type TestTokenAlg = "RS256" | "ES256" | "HS256" | "none";

export interface TestTokenOptions {
	/** Default RS256 with the current key. */
	alg?: TestTokenAlg;
	/** Overrides the `kid` header (an unknown kid, for JWKS tests). */
	kid?: string;
	/** Seconds until `exp` (negative: already expired). Default: the access token TTL. */
	expiresIn?: number;
	/** The `typ` claim: "Bearer" (access), "ID", "Refresh". */
	typ?: string;
}

/** Claims; a key set to `undefined` removes the default claim. */
export type TestClaims = Record<string, unknown>;

export interface TestOidcServerOptions {
	/** Access token lifetime in seconds (Keycloak: 300). */
	accessTokenTtl?: number;
	/** Device flow polling interval in seconds (Keycloak: 5). */
	deviceInterval?: number;
	/** Device code lifetime in seconds (Keycloak: 600). */
	deviceExpiresIn?: number;
	/**
	 * Public issuer when the server sits behind a proxy (a TLS front, say),
	 * e.g. `https://127.0.0.1:8443/realms/sbx`: tokens and discovery carry it.
	 * The path must stay `/realms/sbx`. Default: the server's own address.
	 */
	issuer?: string;
}

export interface TestOidcStats {
	discovery: number;
	jwks: number;
	/** Token endpoint calls of any grant. */
	token: number;
	/** Successful refresh_token grants. */
	refresh: number;
	deviceAuthorization: number;
	revoke: number;
}

export interface TestDeviceFlow {
	/** The person confirmed the code; tokens carry `claims` over the defaults. */
	approve(userCode: string, claims?: TestClaims): void;
	deny(userCode: string): void;
	/** User codes waiting for approval, oldest first. */
	pending(): string[];
	/** Approve every new device request at once with these claims (null: off). */
	autoApprove(claims: TestClaims | null): void;
}

export interface TestOidcServer {
	/** `http://127.0.0.1:<port>/realms/sbx`, or the `issuer` option */
	issuer: string;
	/** The server's own address, `http://127.0.0.1:<port>` */
	base: string;
	/** A signed token: access token claims of Keycloak's `sbx-cli` by default. */
	token(claims?: TestClaims, opts?: TestTokenOptions): Promise<string>;
	/** New current RSA key; old keys stay in the JWKS. */
	rotateKey(): void;
	readonly stats: TestOidcStats;
	deviceFlow: TestDeviceFlow;
	/** Every refresh token stops working (`invalid_grant`), like a disabled user. */
	revokeRefreshTokens(): void;
	/** Make discovery and/or JWKS answer this HTTP status (null: work again). */
	fail(f: { discovery?: number | null; jwks?: number | null }): void;
	close(): Promise<void>;
}

interface SigningKey {
	kid: string;
	alg: "RS256" | "ES256";
	privateKey: KeyObject;
	jwk: Record<string, unknown>;
}

interface DeviceGrant {
	deviceCode: string;
	userCode: string;
	clientId: string;
	expiresAt: number;
	lastPollAt: number;
	interval: number;
	state: "pending" | "approved" | "denied" | "used";
	claims: TestClaims;
}

const HS_SECRET = new TextEncoder().encode("not-a-keycloak-secret-0123456789");

function newKey(alg: "RS256" | "ES256"): SigningKey {
	const { privateKey, publicKey } =
		alg === "RS256"
			? generateKeyPairSync("rsa", { modulusLength: 2048 })
			: generateKeyPairSync("ec", { namedCurve: "P-256" });
	const kid = randomUUID();
	return {
		kid,
		alg,
		privateKey,
		jwk: { ...publicKey.export({ format: "jwk" }), kid, alg, use: "sig" },
	};
}

function b64url(v: unknown): string {
	return Buffer.from(JSON.stringify(v)).toString("base64url");
}

function userCode(): string {
	const A = "BCDFGHJKLMNPQRSTVWXZ";
	const pick = () => A[(randomBytes(1)[0] as number) % A.length];
	return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status).end();
		return;
	}
	res
		.writeHead(status, {
			"content-type": "application/json",
			"cache-control": "no-store",
		})
		.end(JSON.stringify(body));
}

export async function startTestOidcServer(
	o: TestOidcServerOptions = {},
): Promise<TestOidcServer> {
	const accessTtl = o.accessTokenTtl ?? 300;
	const deviceInterval = o.deviceInterval ?? 5;
	const deviceExpiresIn = o.deviceExpiresIn ?? 600;

	const rsaKeys: SigningKey[] = [newKey("RS256")];
	const ecKey = newKey("ES256");
	const devices = new Map<string, DeviceGrant>();
	/** refresh token -> claims of the session (null: revoked). */
	const refreshTokens = new Map<string, TestClaims | null>();
	let auto: TestClaims | null = null;
	const failures: { discovery: number | null; jwks: number | null } = {
		discovery: null,
		jwks: null,
	};
	const stats: TestOidcStats = {
		discovery: 0,
		jwks: 0,
		token: 0,
		refresh: 0,
		deviceAuthorization: 0,
		revoke: 0,
	};

	const server = createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			send(res, 500, { error: "server_error", error_description: String(err) });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;
	const issuer = o.issuer?.replace(/\/+$/, "") ?? `${base}/realms/sbx`;
	const oidcPath = "/realms/sbx/protocol/openid-connect";

	function claimsOf(over: TestClaims, typ: string, ttl: number): TestClaims {
		const now = Math.floor(Date.now() / 1000);
		const all: TestClaims = {
			iss: issuer,
			aud: "sbx-api",
			azp: "sbx-cli",
			sub: "test-user",
			email: "user@example.com",
			email_verified: true,
			preferred_username: "user",
			groups: [],
			scope: "openid email profile",
			jti: randomUUID(),
			iat: now,
			exp: now + ttl,
			typ,
			...over,
		};
		for (const [k, v] of Object.entries(all))
			if (v === undefined) delete all[k];
		return all;
	}

	async function sign(
		claims: TestClaims,
		opts: TestTokenOptions,
	): Promise<string> {
		const alg = opts.alg ?? "RS256";
		if (alg === "none") {
			return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`;
		}
		const key =
			alg === "ES256"
				? ecKey
				: alg === "RS256"
					? (rsaKeys.at(-1) as SigningKey)
					: null;
		const kid = opts.kid ?? key?.kid ?? "hs-key";
		const jwt = new SignJWT(
			claims as Record<string, unknown>,
		).setProtectedHeader({
			alg,
			typ: "JWT",
			kid,
		});
		return jwt.sign(key === null ? HS_SECRET : key.privateKey);
	}

	async function token(claims: TestClaims = {}, opts: TestTokenOptions = {}) {
		const c = claimsOf(
			claims,
			opts.typ ?? "Bearer",
			opts.expiresIn ?? accessTtl,
		);
		return sign(c, opts);
	}

	/** Access, refresh and ID tokens of a session (claims over the defaults). */
	async function tokenSet(session: TestClaims, clientId: string) {
		const claims = { azp: clientId, ...session };
		const refresh = randomBytes(32).toString("base64url");
		refreshTokens.set(refresh, claims);
		return {
			access_token: await token(claims),
			expires_in: accessTtl,
			refresh_token: refresh,
			refresh_expires_in: 86_400,
			token_type: "Bearer",
			id_token: await token({ ...claims, aud: clientId }, { typ: "ID" }),
			"not-before-policy": 0,
			session_state: randomUUID(),
			scope: "openid email profile",
		};
	}

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", base);
		const path = url.pathname;
		if (
			req.method === "GET" &&
			path === "/realms/sbx/.well-known/openid-configuration"
		) {
			stats.discovery++;
			if (failures.discovery !== null) {
				send(res, failures.discovery, { error: "unavailable" });
				return;
			}
			send(res, 200, {
				issuer,
				authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
				token_endpoint: `${issuer}/protocol/openid-connect/token`,
				jwks_uri: `${issuer}/protocol/openid-connect/certs`,
				device_authorization_endpoint: `${issuer}/protocol/openid-connect/auth/device`,
				revocation_endpoint: `${issuer}/protocol/openid-connect/revoke`,
				grant_types_supported: [
					"authorization_code",
					"refresh_token",
					"urn:ietf:params:oauth:grant-type:device_code",
				],
				id_token_signing_alg_values_supported: ["RS256", "ES256"],
			});
			return;
		}
		if (req.method === "GET" && path === `${oidcPath}/certs`) {
			stats.jwks++;
			if (failures.jwks !== null) {
				send(res, failures.jwks, { error: "unavailable" });
				return;
			}
			send(res, 200, { keys: [...rsaKeys, ecKey].map((k) => k.jwk) });
			return;
		}
		if (req.method !== "POST") {
			send(res, 404, { error: "not_found" });
			return;
		}
		const form = await readForm(req);
		if (path === `${oidcPath}/auth/device`) {
			stats.deviceAuthorization++;
			const g: DeviceGrant = {
				deviceCode: randomBytes(32).toString("base64url"),
				userCode: userCode(),
				clientId: form.get("client_id") ?? "",
				expiresAt: Date.now() + deviceExpiresIn * 1000,
				lastPollAt: 0,
				interval: deviceInterval,
				state: auto === null ? "pending" : "approved",
				claims: auto ?? {},
			};
			devices.set(g.deviceCode, g);
			send(res, 200, {
				device_code: g.deviceCode,
				user_code: g.userCode,
				verification_uri: `${issuer}/device`,
				verification_uri_complete: `${issuer}/device?user_code=${g.userCode}`,
				expires_in: deviceExpiresIn,
				interval: deviceInterval,
			});
			return;
		}
		if (path === `${oidcPath}/revoke`) {
			stats.revoke++;
			const t = form.get("token") ?? "";
			if (refreshTokens.has(t)) refreshTokens.set(t, null);
			send(res, 200);
			return;
		}
		if (path === `${oidcPath}/token`) {
			stats.token++;
			await tokenGrant(form, res);
			return;
		}
		send(res, 404, { error: "not_found" });
	}

	async function tokenGrant(form: URLSearchParams, res: ServerResponse) {
		const clientId = form.get("client_id") ?? "";
		const grant = form.get("grant_type");
		const error = (e: string, description?: string) =>
			send(res, 400, {
				error: e,
				...(description ? { error_description: description } : {}),
			});
		if (grant === "refresh_token") {
			const claims = refreshTokens.get(form.get("refresh_token") ?? "");
			if (claims === undefined || claims === null) {
				error("invalid_grant", "Session not active");
				return;
			}
			stats.refresh++;
			send(res, 200, await tokenSet(claims, clientId || String(claims.azp)));
			return;
		}
		if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
			const g = devices.get(form.get("device_code") ?? "");
			if (g === undefined || g.state === "used") {
				error("invalid_grant", "Device code not valid");
				return;
			}
			const now = Date.now();
			if (now > g.expiresAt) {
				error("expired_token");
				return;
			}
			if (g.state === "denied") {
				error("access_denied");
				return;
			}
			if (g.state === "pending") {
				const tooSoon = now - g.lastPollAt < g.interval * 1000;
				g.lastPollAt = now;
				if (tooSoon && g.interval > 0) {
					g.interval += 5;
					error("slow_down");
				} else {
					error("authorization_pending");
				}
				return;
			}
			g.state = "used";
			send(res, 200, await tokenSet(g.claims, g.clientId || "sbx-cli"));
			return;
		}
		error("unsupported_grant_type");
	}

	function byUserCode(code: string): DeviceGrant {
		for (const g of devices.values()) if (g.userCode === code) return g;
		throw new Error(`test OIDC server: unknown user code ${code}`);
	}

	return {
		issuer,
		base,
		token,
		rotateKey() {
			rsaKeys.push(newKey("RS256"));
		},
		stats,
		deviceFlow: {
			approve(code, claims = {}) {
				const g = byUserCode(code);
				g.state = "approved";
				g.claims = claims;
			},
			deny(code) {
				byUserCode(code).state = "denied";
			},
			pending() {
				return [...devices.values()]
					.filter((g) => g.state === "pending")
					.map((g) => g.userCode);
			},
			autoApprove(claims) {
				auto = claims;
			},
		},
		fail(f) {
			if (f.discovery !== undefined) failures.discovery = f.discovery;
			if (f.jwks !== undefined) failures.jwks = f.jwks;
		},
		revokeRefreshTokens() {
			for (const t of refreshTokens.keys()) refreshTokens.set(t, null);
		},
		close() {
			return new Promise((resolve, reject) => {
				server.closeAllConnections();
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}
