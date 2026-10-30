// Raw client (`sbx.raw`): openapi-fetch over the generated `paths`, with
// - headers: Authorization (credential chain), Sbx-Team, User-Agent, and an
//   Idempotency-Key (UUIDv4) on the keyed POSTs of S7 §5.7 when the caller set
//   none; the key is made once per call, so every retry repeats it;
// - the retry policy of retry.ts, limited by `retryBudgetMs`, and `signal`;
// - one new token and one repeat on `401 token_expired`;
// - every error thrown as SbxError (network errors: status 0, `network_error`;
//   a 2xx body that is not the expected JSON: `unexpected_response`).
// A call resolves only on 2xx: `{data, response}`.
// A ReadableStream request body is sent once: it is neither cloned (a tee
// would buffer the whole payload) nor retried. Retryable uploads send bounded
// Uint8Array chunks instead.

import createClient, {
	type FetchOptions,
	type MaybeOptionalInit,
	type Middleware,
	type ParseAsResponse,
} from "openapi-fetch";
import type {
	HttpMethod,
	MediaType,
	PathsWithMethod,
	RequiredKeysOf,
	ResponseObjectMap,
	SuccessResponse,
} from "openapi-typescript-helpers";
import { type Credentials, resolveCredentials } from "./credentials.ts";
import {
	errorFromResponse,
	isAbortError,
	NETWORK_ERROR,
	SbxError,
	UNEXPECTED_RESPONSE,
} from "./errors.ts";
import type { paths } from "./gen/v1.d.ts";
import { newIdempotencyKey, takesIdempotencyKey } from "./ids.ts";
import {
	abortable,
	DEFAULT_RETRY_BUDGET_MS,
	isSafeToRepeat,
	withRetry,
} from "./retry.ts";

/** Version of @sbx/sdk; sent as `User-Agent: sbx-sdk-ts/<version>`. */
export const SDK_VERSION = "0.1.0";

/** Options every facade and raw method accepts (S7 §15.2, S11 §16.1). */
export interface CallOptions {
	/** Aborts the request, waits between retries and long-polls. */
	signal?: AbortSignal;
	/** Total time for retries of this call; default 60 000 ms. */
	retryBudgetMs?: number;
	/** Idempotency-Key to send instead of a generated one. */
	idempotencyKey?: string;
	/**
	 * Time to the response headers of one attempt, then `network_error`
	 * (retried like one); default 60 000 ms for requests without a body or
	 * with a JSON body, none for binary and streamed bodies (an upload takes
	 * as long as it takes); 0 turns it off.
	 */
	timeoutMs?: number;
}

/** Default of `CallOptions.timeoutMs` (as the Python SDK's read timeout). */
export const REQUEST_TIMEOUT_MS = 60_000;
/** A response body with no data for this long is a dead connection. */
export const BODY_IDLE_TIMEOUT_MS = 60_000;

export interface TokenProviderOptions {
	/** The last token was rejected as expired: get a new one. */
	force: boolean;
}

/** What the SDK passes when it opens a WebSocket (the PTY, S7 §10.2). */
export interface WebSocketInit {
	protocols: string[];
	headers: Record<string, string>;
}

/**
 * Opens a WebSocket. The default is the global WebSocket with
 * `{protocols, headers}` in the second argument (Node's undici and Bun take
 * that). Pass one for a private CA or a proxy, e.g. in Bun
 * `(url, init) => new WebSocket(url, { ...init, tls: { ca } })`.
 */
export type WebSocketFactory = (url: string, init: WebSocketInit) => WebSocket;

/** The default WebSocketFactory: the global WebSocket. */
export const defaultWebSocket: WebSocketFactory = (url, init) =>
	new WebSocket(url, init as unknown as string[]);

export interface SbxOptions {
	/** API URL, e.g. https://api.example.com; else SBX_API_URL, else the sbx profile. */
	baseUrl?: string;
	/** Team (`team_...`) sent as Sbx-Team; else SBX_TEAM, else the sbx profile. */
	team?: string;
	/**
	 * Browser session of the dashboard (S8 §9.1): the cookie of the page's
	 * own origin is the credential. No Authorization header is sent and no
	 * credential chain is used; `baseUrl` may be a path (`/api`). The PTY
	 * WebSocket gets the team as `?team=` (browsers set no headers there).
	 */
	session?: boolean;
	apiKey?: string;
	accessToken?: string;
	/**
	 * Called before every request; owns its own caching. `force` is true
	 * after the api answered `401 token_expired` to the token it gave: it
	 * must return a new token, not the cached one.
	 */
	tokenProvider?: (o: TokenProviderOptions) => Promise<string>;
	fetch?: typeof fetch;
	userAgent?: string;
	/** Environment read instead of process.env (also for the `sbx` subprocess). */
	env?: Record<string, string | undefined>;
	/**
	 * Retry budget of a call that passes no `retryBudgetMs`; default
	 * 60 000 ms. Long-poll waits keep their own per-poll budget.
	 */
	retryBudgetMs?: number;
	/** Opens the PTY WebSocket (TLS options, proxies); default the global WebSocket. */
	webSocket?: WebSocketFactory;
	/** Default ["sbx", "auth", "token", "--json"]. */
	authCommand?: string[];
	/**
	 * A command stream (run, follow) with no line for this long is treated as
	 * a dead connection and reopened from its offsets; default 45 000 ms.
	 */
	streamIdleTimeoutMs?: number;
}

/** `undefined` when the answer has no body: a HEAD request, or a route with a 204 answer. */
type EmptyData<T, M> =
	| (M extends "head" ? undefined : never)
	| (204 extends keyof ResponseObjectMap<T> ? undefined : never);

/**
 * A successful response: `data` parsed as asked by `parseAs` (JSON by default),
 * `undefined` for HEAD and 204 answers.
 * Unlike openapi-fetch, the type is not wrapped in its `Readable<>`: the
 * generator emits no $Read/$Write markers, and `Readable<>` would turn the
 * `(string & {})` of open enums into an object type.
 */
export interface RawResponse<T, Init, M = never> {
	data:
		| (ResponseObjectMap<T> extends infer R extends Record<
				string | number,
				unknown
		  >
				? ParseAsResponse<SuccessResponse<R, MediaType>, Init>
				: never)
		| EmptyData<T, M>;
	response: Response;
}

/** The openapi-fetch init of a route plus CallOptions. */
type WithCallOptions<I> = I extends undefined ? undefined : I & CallOptions;

type RawInitParam<Init> = RequiredKeysOf<Init> extends never ? [Init?] : [Init];

export type RawMethod<M extends HttpMethod> = <
	P extends PathsWithMethod<paths, M>,
	Init extends WithCallOptions<MaybeOptionalInit<paths[P], M>>,
>(
	url: P,
	...init: RawInitParam<Init>
) => Promise<RawResponse<paths[P][M], Init, M>>;

export interface RawClient {
	GET: RawMethod<"get">;
	PUT: RawMethod<"put">;
	POST: RawMethod<"post">;
	DELETE: RawMethod<"delete">;
	HEAD: RawMethod<"head">;
	PATCH: RawMethod<"patch">;
}

type LooseInit = FetchOptions<unknown> & CallOptions;

/** The raw client plus what the facade needs beside it (WebSocket URL and bearer). */
export interface ClientCore {
	raw: RawClient;
	/** Resolved credentials (memoised; a failure is not kept). */
	credentials(signal?: AbortSignal): Promise<Credentials>;
	userAgent: string;
	streamIdleTimeoutMs: number;
	/** `SbxOptions.retryBudgetMs` or the default. */
	retryBudgetMs: number;
	/** `SbxOptions.webSocket` or the global WebSocket. */
	webSocket: WebSocketFactory;
}

/** Default of `SbxOptions.streamIdleTimeoutMs` (S7 §9.7: 45 s without lines). */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

export function createRawClient(opts: SbxOptions = {}): RawClient {
	return createClientCore(opts).raw;
}

/** For the facade (`Sbx`): the raw client and its credentials. */
export function createClientCore(opts: SbxOptions = {}): ClientCore {
	const fetchImpl: (req: Request) => Promise<Response> =
		opts.fetch ?? ((req) => globalThis.fetch(req));
	const userAgent = opts.userAgent ?? `sbx-sdk-ts/${SDK_VERSION}`;
	const defaultBudgetMs = opts.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
	// Command streams have their own (shorter) idle limit; never below it.
	const bodyIdleMs = Math.max(
		BODY_IDLE_TIMEOUT_MS,
		opts.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
	);

	// Resolved on the first call; a failure is not kept, so `sbx login` later helps.
	let pending: Promise<Credentials> | undefined;
	const credentials = () => {
		if (!pending) {
			const p = resolveCredentials(opts);
			pending = p;
			p.catch(() => {
				if (pending === p) pending = undefined;
			});
		}
		return pending;
	};

	const client = createClient<paths>();
	const headers: Middleware = {
		async onRequest({ request, schemaPath }) {
			const creds = await credentials();
			const h = request.headers;
			if (!creds.session) {
				h.set(
					"Authorization",
					`Bearer ${await creds.getToken(false, request.signal)}`,
				);
			}
			if (creds.team !== undefined && !h.has("Sbx-Team")) {
				h.set("Sbx-Team", creds.team);
			}
			h.set("User-Agent", userAgent);
			if (
				!h.has("Idempotency-Key") &&
				takesIdempotencyKey(request.method, schemaPath)
			) {
				h.set("Idempotency-Key", newIdempotencyKey());
			}
			return request;
		},
	};
	client.use(headers);

	/**
	 * fetch for one call: retries, token refresh, errors as SbxError.
	 * `oneShot`: the body is a stream, sent once without a clone or a retry
	 * (the error keeps its `retryable`: the caller may send a new body).
	 * `seen` keeps the last response, for errors raised after the fetch.
	 */
	const transport =
		(
			creds: Credentials,
			seen: { response?: Response },
			signal?: AbortSignal,
			budgetMs?: number,
			oneShot = false,
			headerTimeoutMs = 0,
		) =>
		(request: Request): Promise<Response> => {
			const keyed = request.headers.has("Idempotency-Key");
			const send = async (): Promise<Response> => {
				const base = oneShot ? request : request.clone();
				const timeout = new AbortController();
				let timedOut = false;
				const timer =
					headerTimeoutMs > 0
						? setTimeout(() => {
								timedOut = true;
								timeout.abort();
							}, headerTimeoutMs)
						: undefined;
				// Redirects are not followed (like the Python SDK): a 3xx is an error.
				const init: RequestInit & { duplex?: "half" } = {
					signal: AbortSignal.any([base.signal, timeout.signal]),
					redirect: "manual",
				};
				if (base.body !== null) init.duplex = "half";
				let res: Response;
				try {
					res = await fetchImpl(new Request(base, init));
				} catch (err) {
					if (signal?.aborted) throw signal.reason;
					if (timedOut) {
						throw networkError(
							new Error(`no response headers within ${headerTimeoutMs} ms`),
							request.method,
							keyed,
						);
					}
					if (isAbortError(err)) throw err;
					throw networkError(err, request.method, keyed);
				} finally {
					clearTimeout(timer);
				}
				seen.response = res;
				if (!res.ok) throw await errorFromResponse(res);
				return withBodyIdleTimeout(
					res,
					bodyIdleMs,
					isSafeToRepeat(request.method, keyed),
				);
			};
			if (oneShot) return send();
			let refreshed = false;
			return withRetry(
				async () => {
					try {
						return await send();
					} catch (err) {
						if (refreshed || creds.session || !isTokenExpired(err)) throw err;
						refreshed = true;
						const token = await creds.getToken(true, signal);
						request.headers.set("Authorization", `Bearer ${token}`);
						return await send();
					}
				},
				{ method: request.method, idempotent: keyed, signal, budgetMs },
			);
		};

	const call =
		(method: string) =>
		async (url: string, init: LooseInit = {}): Promise<unknown> => {
			const { signal, retryBudgetMs, idempotencyKey, timeoutMs, ...rest } =
				init;
			const creds = await abortable(credentials(), signal);
			const requestHeaders =
				idempotencyKey === undefined
					? rest.headers
					: mergeHeaders(rest.headers, idempotencyKey);
			const oneShot = (rest.body as unknown) instanceof ReadableStream;
			const headerTimeoutMs =
				timeoutMs ?? (isJsonBody(rest.body) ? REQUEST_TIMEOUT_MS : 0);
			const seen: { response?: Response } = {};
			try {
				const { data, response } = await client.request(
					method as "get",
					url as never,
					{
						...rest,
						...(requestHeaders === undefined
							? {}
							: { headers: requestHeaders }),
						...(signal === undefined ? {} : { signal }),
						// Node and Bun need it for a streamed request body.
						...(oneShot ? { duplex: "half" } : {}),
						baseUrl: creds.baseUrl,
						fetch: transport(
							creds,
							seen,
							signal,
							retryBudgetMs ?? defaultBudgetMs,
							oneShot,
							headerTimeoutMs,
						),
					} as never,
				);
				return { data, response };
			} catch (err) {
				if (err instanceof SbxError || isAbortError(err)) throw err;
				if (signal?.aborted) throw signal.reason;
				if (err instanceof SyntaxError && seen.response?.ok) {
					throw malformedAnswer(seen.response, err);
				}
				throw err;
			}
		};

	return {
		raw: {
			GET: call("get"),
			PUT: call("put"),
			POST: call("post"),
			DELETE: call("delete"),
			HEAD: call("head"),
			PATCH: call("patch"),
		} as unknown as RawClient,
		credentials: (signal) => abortable(credentials(), signal),
		userAgent,
		streamIdleTimeoutMs: opts.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
		retryBudgetMs: defaultBudgetMs,
		webSocket: opts.webSocket ?? defaultWebSocket,
	};
}

/** A 2xx answer whose body is not the JSON the route promises. */
function malformedAnswer(res: Response, cause: unknown): SbxError {
	return new SbxError({
		status: res.status,
		code: UNEXPECTED_RESPONSE,
		message: `HTTP ${res.status} with a body that is not valid JSON`,
		retryable: false,
		requestId: res.headers.get("Request-Id"),
		cause,
	});
}

function mergeHeaders(
	headers: FetchOptions<unknown>["headers"],
	idempotencyKey: string,
): Headers {
	const h = new Headers();
	if (headers instanceof Headers || Array.isArray(headers)) {
		new Headers(headers).forEach((v, k) => {
			h.set(k, v);
		});
	} else if (headers) {
		for (const [k, v] of Object.entries(headers)) {
			if (v === null || v === undefined) continue;
			h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
		}
	}
	h.set("Idempotency-Key", idempotencyKey);
	return h;
}

/** No body, or one that openapi-fetch serializes as JSON. */
function isJsonBody(body: unknown): boolean {
	if (body === undefined || body === null || typeof body === "string") {
		return true;
	}
	if (typeof body !== "object") return true;
	const proto = Object.getPrototypeOf(body);
	return proto === Object.prototype || proto === null || Array.isArray(body);
}

/** Statuses whose Response must have a null body (Fetch standard). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** The response with a body that fails after `ms` without data. */
function withBodyIdleTimeout(
	res: Response,
	ms: number,
	retryable: boolean,
): Response {
	const source = res.body;
	if (source === null) return res;
	// A null-body status (204, 205, 304) cannot be rebuilt around a body;
	// browsers give such answers an empty body stream anyway.
	if (NULL_BODY_STATUSES.has(res.status)) {
		source.cancel().catch(() => {});
		return new Response(null, {
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
		});
	}
	const reader = source.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(ctl) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new SbxError({
								status: 0,
								code: NETWORK_ERROR,
								message: `network error: no response data for ${ms} ms`,
								retryable,
							}),
						),
					ms,
				);
			});
			try {
				const r = await Promise.race([reader.read(), idle]);
				if (r.done) ctl.close();
				else ctl.enqueue(r.value);
			} catch (err) {
				reader.cancel().catch(() => {});
				ctl.error(err);
			} finally {
				clearTimeout(timer);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

function networkError(cause: unknown, method: string, keyed: boolean) {
	const why = cause instanceof Error ? cause.message : String(cause);
	return new SbxError({
		status: 0,
		code: NETWORK_ERROR,
		message: `network error: ${why}`,
		// The outcome is unknown: only a request that may run twice is safe.
		retryable: isSafeToRepeat(method, keyed),
		cause,
	});
}

function isTokenExpired(err: unknown): boolean {
	return (
		err instanceof SbxError &&
		err.status === 401 &&
		err.code === "token_expired"
	);
}
