// Keycloak Admin REST API client of ctl-idp-sync (S8 §20.1): a client
// credentials token of `umiak-worker` (service account with the
// `realm-management` role `view-users`), the paged user list and a single
// user lookup. Plain fetch, no library. The client secret and the token
// never appear in errors.

export interface KeycloakUser {
	/** Keycloak user id (= `sub` = `users.idpSubject`). */
	id: string;
	enabled: boolean;
}

export interface KeycloakAdminClientOptions {
	/** Keycloak base URL (internal address), without `/realms`. */
	baseUrl: string;
	realm: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
	/** Users per page of `GET /users` (default 100). */
	pageSize?: number;
	/** Timeout of every HTTP request (default 10 s). */
	timeoutMs?: number;
}

/** A failed Keycloak call: a non-2xx status, a timeout or a malformed body. */
export class KeycloakError extends Error {
	readonly status: number | undefined;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "KeycloakError";
		this.status = status;
	}
}

/** listUsers gives up after this many pages (a server that ignores `first`). */
export const MAX_USER_PAGES = 10_000;

/** Renews the token this long before it expires. */
const TOKEN_MARGIN_MS = 30_000;

export class KeycloakAdminClient {
	readonly #base: string;
	readonly #realm: string;
	readonly #clientId: string;
	readonly #clientSecret: string;
	readonly #fetch: typeof fetch;
	readonly #pageSize: number;
	readonly #timeoutMs: number;
	#token: { value: string; expiresAt: number } | undefined;

	constructor(o: KeycloakAdminClientOptions) {
		this.#base = o.baseUrl.replace(/\/+$/, "");
		this.#realm = o.realm;
		this.#clientId = o.clientId;
		this.#clientSecret = o.clientSecret;
		this.#fetch = o.fetch ?? fetch;
		this.#pageSize = o.pageSize ?? 100;
		this.#timeoutMs = o.timeoutMs ?? 10_000;
		if (!Number.isInteger(this.#pageSize) || this.#pageSize < 1) {
			throw new Error(
				"KeycloakAdminClient: pageSize must be a positive integer",
			);
		}
	}

	/**
	 * Every user of the realm: pages of `GET /users?briefRepresentation=true`
	 * until an empty page. Any failed page throws: a partial list is never
	 * returned. A user seen on two pages (the list shifted) is kept once.
	 * A full page without a new user, or more than MAX_USER_PAGES pages,
	 * throws instead of looping forever.
	 */
	async listUsers(): Promise<KeycloakUser[]> {
		const out = new Map<string, KeycloakUser>();
		for (let n = 0, first = 0; ; n++, first += this.#pageSize) {
			if (n >= MAX_USER_PAGES) {
				throw new KeycloakError(
					`keycloak: GET users: more than ${MAX_USER_PAGES} pages`,
				);
			}
			const q = new URLSearchParams({
				briefRepresentation: "true",
				first: String(first),
				max: String(this.#pageSize),
			});
			const res = await this.#admin(`/users?${q}`);
			if (!res.ok) {
				throw new KeycloakError(
					`keycloak: GET users (first=${first}) returned ${res.status}`,
					res.status,
				);
			}
			const page = parseUsers(await readJson(res, "GET users"));
			if (page.length === 0) break;
			const before = out.size;
			for (const u of page) out.set(u.id, u);
			if (page.length >= this.#pageSize && out.size === before) {
				throw new KeycloakError(
					`keycloak: GET users (first=${first}): a full page without new users`,
				);
			}
		}
		return [...out.values()];
	}

	/** `GET /users/{id}`: `404` is false, other non-2xx statuses throw. */
	async userExists(id: string): Promise<boolean> {
		const res = await this.#admin(`/users/${encodeURIComponent(id)}`);
		if (res.status === 404) {
			await res.body?.cancel();
			return false;
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new KeycloakError(
				`keycloak: GET user returned ${res.status}`,
				res.status,
			);
		}
		await res.body?.cancel();
		return true;
	}

	/** A request to the admin API; a `401` renews the token and retries once. */
	async #admin(path: string): Promise<Response> {
		const url = `${this.#base}/admin/realms/${encodeURIComponent(this.#realm)}${path}`;
		for (let attempt = 0; ; attempt++) {
			const token = await this.#accessToken();
			const res = await this.#call(url, {
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
				},
			});
			if (res.status !== 401 || attempt > 0) return res;
			await res.body?.cancel();
			this.#token = undefined;
		}
	}

	async #accessToken(): Promise<string> {
		if (this.#token && Date.now() < this.#token.expiresAt) {
			return this.#token.value;
		}
		const url = `${this.#base}/realms/${encodeURIComponent(this.#realm)}/protocol/openid-connect/token`;
		const res = await this.#call(url, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				accept: "application/json",
			},
			body: new URLSearchParams({
				grant_type: "client_credentials",
				client_id: this.#clientId,
				client_secret: this.#clientSecret,
			}).toString(),
		});
		if (!res.ok) {
			await res.body?.cancel();
			throw new KeycloakError(
				`keycloak: token request returned ${res.status}`,
				res.status,
			);
		}
		const body = (await readJson(res, "token")) as {
			access_token?: unknown;
			expires_in?: unknown;
		};
		if (typeof body.access_token !== "string" || body.access_token === "") {
			throw new KeycloakError("keycloak: token response has no access_token");
		}
		const ttlMs =
			typeof body.expires_in === "number" && body.expires_in > 0
				? body.expires_in * 1000
				: 60_000;
		this.#token = {
			value: body.access_token,
			expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_MARGIN_MS),
		};
		return body.access_token;
	}

	async #call(url: string, init: RequestInit): Promise<Response> {
		try {
			// The timer holds the controller: an AbortSignal.timeout that nothing
			// references can be collected during the fetch (undici follows the
			// signal through a WeakRef), and then it never aborts. The timer is not
			// cleared on purpose, so it also bounds reading the body.
			const c = new AbortController();
			setTimeout(
				() =>
					c.abort(new DOMException("The operation timed out.", "TimeoutError")),
				this.#timeoutMs,
			).unref();
			return await this.#fetch(url, { ...init, signal: c.signal });
		} catch (err) {
			// The URL carries no secret; the cause is a network error or the timeout.
			const what = err instanceof Error ? err.message : String(err);
			throw new KeycloakError(
				`keycloak: ${init.method ?? "GET"} ${new URL(url).pathname} failed: ${what}`,
			);
		}
	}
}

async function readJson(res: Response, what: string): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		throw new KeycloakError(`keycloak: ${what}: body is not JSON`);
	}
}

function parseUsers(body: unknown): KeycloakUser[] {
	if (!Array.isArray(body)) {
		throw new KeycloakError("keycloak: GET users: body is not an array");
	}
	return body.map((u) => {
		const r = u as { id?: unknown; enabled?: unknown } | null;
		if (
			typeof r?.id !== "string" ||
			r.id === "" ||
			typeof r.enabled !== "boolean"
		) {
			throw new KeycloakError(
				"keycloak: GET users: a user has no id or enabled flag",
			);
		}
		return { id: r.id, enabled: r.enabled };
	});
}
