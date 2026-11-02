// Keycloak endpoints of the CLI (S7 §7.6): the OAuth 2.0 Device Authorization
// Grant (RFC 8628) with the public client `umiak-cli`, the refresh_token grant
// and revocation (RFC 7009). Paths are Keycloak's under the issuer.

import { NETWORK_ERROR, UmiakError } from "@umiak/sdk";
import { CliError, LOGIN_FAILED, LOGIN_REQUIRED } from "../exit-codes.ts";
import { type Fetch, send } from "../http.ts";

export interface TokenSet {
	accessToken: string;
	refreshToken: string;
	/** ISO time the access token expires. */
	expiresAt: string;
}

export interface DeviceCode {
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string | null;
	expiresIn: number;
}

export interface DeviceLoginOptions {
	issuer: string;
	clientId: string;
	fetch: Fetch;
	/** Shows the code and the link (and may open a browser). */
	onCode(code: DeviceCode): void;
	sleep?: (ms: number) => Promise<void>;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function endpoint(issuer: string, name: string): string {
	return `${issuer.replace(/\/+$/, "")}/protocol/openid-connect/${name}`;
}

interface OAuthAnswer {
	status: number;
	body: Record<string, unknown>;
}

async function postForm(
	f: Fetch,
	url: string,
	form: Record<string, string>,
	signal?: AbortSignal,
): Promise<OAuthAnswer> {
	const res = await send(
		f,
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: new URLSearchParams(form).toString(),
			...(signal === undefined ? {} : { signal }),
		}),
		signal,
	);
	const text = await readText(res);
	let body: unknown;
	try {
		body = text === "" ? {} : JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw idpError(res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
	}
	return { status: res.status, body: body as Record<string, unknown> };
}

/** The body; a timeout while reading it is a network error like one before it. */
async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch (err) {
		throw new UmiakError({
			status: 0,
			code: NETWORK_ERROR,
			message: `Keycloak: ${(err as Error).message}`,
			retryable: true,
			cause: err,
		});
	}
}

/** Keycloak answered something that is not OAuth: retryable on 5xx and 429. */
function idpError(status: number, message: string): UmiakError {
	return new UmiakError({
		status,
		code: "idp_error",
		message: `Keycloak: ${message}`,
		retryable: status >= 500 || status === 429,
	});
}

function oauthError(a: OAuthAnswer): string {
	return typeof a.body.error === "string" ? a.body.error : "";
}

function tokenSet(a: OAuthAnswer, oldRefresh?: string): TokenSet {
	const b = a.body;
	const refresh =
		typeof b.refresh_token === "string" ? b.refresh_token : oldRefresh;
	if (typeof b.access_token !== "string" || refresh === undefined) {
		throw idpError(a.status, "the token answer has no access or refresh token");
	}
	const expiresIn = typeof b.expires_in === "number" ? b.expires_in : 300;
	return {
		accessToken: b.access_token,
		refreshToken: refresh,
		expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
	};
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs the device flow to the end: tokens, or CliError `login_failed` (exit 4). */
export async function deviceLogin(o: DeviceLoginOptions): Promise<TokenSet> {
	const sleep = o.sleep ?? realSleep;
	const start = await postForm(o.fetch, endpoint(o.issuer, "auth/device"), {
		client_id: o.clientId,
		scope: "openid",
	});
	const s = start.body;
	if (
		start.status !== 200 ||
		typeof s.device_code !== "string" ||
		typeof s.user_code !== "string" ||
		typeof s.verification_uri !== "string"
	) {
		const why = oauthError(start) || `HTTP ${start.status}`;
		throw idpError(start.status, `device authorization failed: ${why}`);
	}
	const expiresIn = typeof s.expires_in === "number" ? s.expires_in : 600;
	o.onCode({
		userCode: s.user_code,
		verificationUri: s.verification_uri,
		verificationUriComplete:
			typeof s.verification_uri_complete === "string"
				? s.verification_uri_complete
				: null,
		expiresIn,
	});
	let interval = typeof s.interval === "number" ? s.interval : 5;
	const deadline = Date.now() + expiresIn * 1000;
	for (;;) {
		await sleep(interval * 1000);
		const a = await postForm(o.fetch, endpoint(o.issuer, "token"), {
			grant_type: DEVICE_GRANT,
			device_code: s.device_code,
			client_id: o.clientId,
		});
		if (a.status === 200) return tokenSet(a);
		const err = oauthError(a);
		if (err === "authorization_pending") {
			if (Date.now() > deadline) throw expired();
			continue;
		}
		if (err === "slow_down") {
			interval += 5;
			continue;
		}
		if (err === "expired_token") throw expired();
		if (err === "access_denied") {
			throw new CliError({
				code: LOGIN_FAILED,
				message: "the login was denied in the browser",
				retryable: false,
			});
		}
		throw idpError(
			a.status,
			`device login failed: ${err || `HTTP ${a.status}`}`,
		);
	}
}

function expired(): CliError {
	return new CliError({
		code: LOGIN_FAILED,
		message: "the login code expired before it was confirmed; run: umiak login",
		retryable: false,
	});
}

/** A new access token; `invalid_grant` (session over, user disabled) → `login_required`. */
export async function refreshTokens(o: {
	issuer: string;
	clientId: string;
	refreshToken: string;
	fetch: Fetch;
	/** Ends a hanging request (network_error, retryable). */
	signal?: AbortSignal;
}): Promise<TokenSet> {
	const a = await postForm(
		o.fetch,
		endpoint(o.issuer, "token"),
		{
			grant_type: "refresh_token",
			refresh_token: o.refreshToken,
			client_id: o.clientId,
		},
		o.signal,
	);
	if (a.status === 200) return tokenSet(a, o.refreshToken);
	if (oauthError(a) === "invalid_grant") {
		throw new CliError({
			code: LOGIN_REQUIRED,
			message: "the login session has ended; run: umiak login",
			retryable: false,
		});
	}
	throw idpError(
		a.status,
		`token refresh failed: ${oauthError(a) || `HTTP ${a.status}`}`,
	);
}

/** Revokes a refresh token (logout). */
export async function revokeRefreshToken(o: {
	issuer: string;
	clientId: string;
	refreshToken: string;
	fetch: Fetch;
	signal?: AbortSignal;
}): Promise<void> {
	const a = await postForm(
		o.fetch,
		endpoint(o.issuer, "revoke"),
		{
			client_id: o.clientId,
			token: o.refreshToken,
			token_type_hint: "refresh_token",
		},
		o.signal,
	);
	if (a.status !== 200) {
		throw idpError(
			a.status,
			`revocation failed: ${oauthError(a) || `HTTP ${a.status}`}`,
		);
	}
}
