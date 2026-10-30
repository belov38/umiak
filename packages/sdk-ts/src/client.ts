// Raw client (`sbx.raw`): openapi-fetch over the generated `paths`, with
// - headers: Authorization (credential chain), Sbx-Team, User-Agent, and an
//   Idempotency-Key (UUIDv4) on the keyed POSTs of S7 §5.7 when the caller set
//   none; the key is made once per call, so every retry repeats it;
// - the retry policy of retry.ts, limited by `retryBudgetMs`, and `signal`;
// - one new token and one repeat on `401 token_expired`;
// - every error thrown as SbxError (network errors: status 0, `network_error`).
// A call resolves only on 2xx: `{data, response}`.

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
} from "./errors.ts";
import type { paths } from "./gen/v1.d.ts";
import { newIdempotencyKey, takesIdempotencyKey } from "./ids.ts";
import { isSafeToRepeat, withRetry } from "./retry.ts";

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
}

export interface SbxOptions {
	/** API URL, e.g. https://api.example.com; else SBX_API_URL, else the sbx profile. */
	baseUrl?: string;
	/** Team (`team_...`) sent as Sbx-Team; else SBX_TEAM, else the sbx profile. */
	team?: string;
	apiKey?: string;
	accessToken?: string;
	/** Called before every request; owns its own caching. */
	tokenProvider?: () => Promise<string>;
	fetch?: typeof fetch;
	userAgent?: string;
	/** Environment read instead of process.env (also for the `sbx` subprocess). */
	env?: Record<string, string | undefined>;
	/** Default ["sbx", "auth", "token", "--json"]. */
	authCommand?: string[];
}

/**
 * A successful response: `data` parsed as asked by `parseAs` (JSON by default).
 * Unlike openapi-fetch, the type is not wrapped in its `Readable<>`: the
 * generator emits no $Read/$Write markers, and `Readable<>` would turn the
 * `(string & {})` of open enums into an object type.
 */
export interface RawResponse<T, Init> {
	data: ResponseObjectMap<T> extends infer R extends Record<
		string | number,
		unknown
	>
		? ParseAsResponse<SuccessResponse<R, MediaType>, Init>
		: never;
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
) => Promise<RawResponse<paths[P][M], Init>>;

export interface RawClient {
	GET: RawMethod<"get">;
	PUT: RawMethod<"put">;
	POST: RawMethod<"post">;
	DELETE: RawMethod<"delete">;
	HEAD: RawMethod<"head">;
	PATCH: RawMethod<"patch">;
}

type LooseInit = FetchOptions<unknown> & CallOptions;

export function createRawClient(opts: SbxOptions = {}): RawClient {
	const fetchImpl: (req: Request) => Promise<Response> =
		opts.fetch ?? ((req) => globalThis.fetch(req));
	const userAgent = opts.userAgent ?? `sbx-sdk-ts/${SDK_VERSION}`;

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
			h.set("Authorization", `Bearer ${await creds.getToken()}`);
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

	/** fetch for one call: retries, token refresh, errors as SbxError. */
	const transport =
		(creds: Credentials, signal?: AbortSignal, budgetMs?: number) =>
		(request: Request): Promise<Response> => {
			const keyed = request.headers.has("Idempotency-Key");
			const send = async (): Promise<Response> => {
				let res: Response;
				try {
					res = await fetchImpl(request.clone());
				} catch (err) {
					if (signal?.aborted) throw signal.reason;
					if (isAbortError(err)) throw err;
					throw networkError(err, request.method, keyed);
				}
				if (!res.ok) throw await errorFromResponse(res);
				return res;
			};
			let refreshed = false;
			return withRetry(
				async () => {
					try {
						return await send();
					} catch (err) {
						if (refreshed || !isTokenExpired(err)) throw err;
						refreshed = true;
						const token = await creds.getToken(true);
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
			const { signal, retryBudgetMs, idempotencyKey, ...rest } = init;
			const creds = await abortable(credentials(), signal);
			const requestHeaders =
				idempotencyKey === undefined
					? rest.headers
					: mergeHeaders(rest.headers, idempotencyKey);
			const { data, response } = await client.request(
				method as "get",
				url as never,
				{
					...rest,
					...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
					...(signal === undefined ? {} : { signal }),
					baseUrl: creds.baseUrl,
					fetch: transport(creds, signal, retryBudgetMs),
				} as never,
			);
			return { data, response };
		};

	return {
		GET: call("get"),
		PUT: call("put"),
		POST: call("post"),
		DELETE: call("delete"),
		HEAD: call("head"),
		PATCH: call("patch"),
	} as unknown as RawClient;
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

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}
