// GatewayPort over the gateway's internal listener (S2 §5.2, §8.4): the call
// goes to the instance that owns the machine's tunnel, found through the S2
// registry (`@sbx/agent-client` PgRegistry: connected session, live instance).
import {
	HEADER_ERROR_CODE,
	HEADER_INSTANCE_URL,
	type Registry,
	SCHEME_BEARER,
} from "@sbx/agent-client";
import {
	type GatewayPort,
	GatewayRejected,
	GatewayUnavailable,
} from "../ports.ts";

export interface HttpGatewayPortOptions {
	/** Worker's service token for the internal listener (S2 §5.5). Never logged. */
	serviceToken: string;
	fetch?: typeof fetch;
	/** Per-request deadline; the gateway bounds a rotation at 30 s. */
	timeoutMs?: number;
}

/** The registry calls the port needs (PgRegistry in production). */
export type GatewayRegistry = Pick<
	Registry,
	"lookup" | "invalidate" | "isLiveInstance"
>;

/** One attempt plus one retry after a 421 machine_moved. */
const MAX_ATTEMPTS = 2;

/** 4xx answers that mean "not here right now" rather than "never". */
const TRANSIENT_4XX = new Set([404, 408, 409, 410, 421, 425, 429]);

/** Answers after which the cached route is not trusted any more. */
const STALE_ROUTE = new Set([421, 503]);

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Error code and 421 hint: headers first, then the JSON body `{code, instanceUrl}`. */
async function errorInfo(
	res: Response,
): Promise<{ code?: string; instanceUrl?: string }> {
	let code = res.headers.get(HEADER_ERROR_CODE) || undefined;
	let instanceUrl = res.headers.get(HEADER_INSTANCE_URL) || undefined;
	try {
		const body = (await res.json()) as {
			code?: unknown;
			instanceUrl?: unknown;
		};
		if (code === undefined && typeof body.code === "string") code = body.code;
		if (instanceUrl === undefined && typeof body.instanceUrl === "string")
			instanceUrl = body.instanceUrl || undefined;
	} catch {
		// not JSON
	}
	return {
		...(code === undefined ? {} : { code }),
		...(instanceUrl === undefined ? {} : { instanceUrl }),
	};
}

export class HttpGatewayPort implements GatewayPort {
	readonly #registry: GatewayRegistry;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(registry: GatewayRegistry, o: HttpGatewayPortOptions) {
		this.#registry = registry;
		this.#token = o.serviceToken;
		this.#fetch = o.fetch ?? fetch;
		this.#timeoutMs = o.timeoutMs ?? 35_000;
	}

	/**
	 * `POST <internal_url>/v1/machines/{id}/rotate-token`. On `421
	 * machine_moved` the cached route is dropped and the call is repeated once
	 * against the new owner: a fresh registry route if it names another
	 * instance, else the answer's `Sbx-Instance-Url` when the registry knows it
	 * as a live instance (the hint is never followed blindly: the service
	 * token goes only to registered instances). No owner, a moved route, a
	 * connection error, a registry failure or 5xx are transient
	 * (`GatewayUnavailable`); 401, 403 and other 4xx are a permanent
	 * `GatewayRejected`. The worker's job retries do the waiting.
	 */
	async rotateToken(machineId: string): Promise<void> {
		const what = `rotate-token for machine ${machineId}`;
		const route = await this.#lookup(machineId, what);
		if (route === undefined)
			throw new GatewayUnavailable(
				`machine ${machineId} has no connected tunnel on a live gateway instance`,
			);
		let base = trimSlash(route);
		for (let attempt = 1; ; attempt++) {
			const url = `${base}/v1/machines/${encodeURIComponent(machineId)}/rotate-token`;
			let res: Response;
			try {
				res = await this.#fetch(url, {
					method: "POST",
					headers: { Authorization: `${SCHEME_BEARER} ${this.#token}` },
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
			} catch (err) {
				this.#registry.invalidate(machineId);
				throw new GatewayUnavailable(`${what}: ${errText(err)}`);
			}
			if (res.ok) {
				await res.body?.cancel();
				return;
			}
			const info = await errorInfo(res);
			if (STALE_ROUTE.has(res.status)) this.#registry.invalidate(machineId);
			if (res.status === 421 && attempt < MAX_ATTEMPTS) {
				const next = await this.#newOwner(machineId, base, info.instanceUrl);
				if (next !== undefined) {
					base = next;
					continue;
				}
			}
			const msg = `${what}: HTTP ${res.status}${info.code ? ` ${info.code}` : ""}`;
			if (res.status >= 500 || TRANSIENT_4XX.has(res.status))
				throw new GatewayUnavailable(msg);
			throw new GatewayRejected(
				info.code ??
					(res.status === 401 ? "unauthenticated" : `http_${res.status}`),
				msg,
			);
		}
	}

	/** Internal URL of the owner instance, or undefined when there is none. */
	async #lookup(machineId: string, what: string): Promise<string | undefined> {
		try {
			return (await this.#registry.lookup(machineId))?.internalUrl;
		} catch (err) {
			// The registry throws TypeError for a malformed machine id: never valid.
			if (err instanceof TypeError)
				throw new GatewayRejected(
					"invalid_machine_id",
					`${what}: ${err.message}`,
				);
			throw new GatewayUnavailable(`${what}: registry: ${errText(err)}`, {
				cause: err,
			});
		}
	}

	/**
	 * Where to go after a 421 from `tried`: a fresh route naming another
	 * instance, else a hint the registry confirms as a live instance.
	 */
	async #newOwner(
		machineId: string,
		tried: string,
		hint: string | undefined,
	): Promise<string | undefined> {
		const fresh = await this.#registry.lookup(machineId).catch(() => undefined);
		if (fresh !== undefined && trimSlash(fresh.internalUrl) !== tried)
			return trimSlash(fresh.internalUrl);
		if (hint === undefined || trimSlash(hint) === tried) return undefined;
		const live = await this.#registry.isLiveInstance(hint).catch(() => false);
		return live ? trimSlash(hint) : undefined;
	}
}

/**
 * GatewayPort when the worker has no service token
 * (`SBX_GATEWAY_SERVICE_TOKEN_FILE` unset): every rotation is the transient
 * `GatewayUnavailable`, so a create waits in retries until the deadline
 * instead of failing at once.
 */
export class UnconfiguredGatewayPort implements GatewayPort {
	async rotateToken(machineId: string): Promise<void> {
		throw new GatewayUnavailable(
			`gateway not configured (SBX_GATEWAY_SERVICE_TOKEN_FILE unset); cannot rotate the token of machine ${machineId}`,
		);
	}
}
