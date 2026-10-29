// GatewayPort over the gateway's internal listener (S2 §5.5, §8.4): the call
// goes to the instance that owns the machine's tunnel.
import type pg from "pg";
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
	/** An instance whose heartbeat is older is not an owner (S2 §8.3: 15 s). */
	staleAfterS?: number;
}

/** 4xx answers that mean "not here right now" rather than "never". */
const TRANSIENT_4XX = new Set([404, 408, 409, 410, 421, 425, 429]);

async function errorCode(res: Response): Promise<string | undefined> {
	const header = res.headers.get("sbx-error-code");
	if (header) return header;
	try {
		const body = (await res.json()) as { code?: unknown };
		return typeof body.code === "string" ? body.code : undefined;
	} catch {
		return undefined;
	}
}

export class HttpGatewayPort implements GatewayPort {
	readonly #pool: Pick<pg.Pool, "query">;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	readonly #staleAfterS: number;

	constructor(pool: Pick<pg.Pool, "query">, o: HttpGatewayPortOptions) {
		this.#pool = pool;
		this.#token = o.serviceToken;
		this.#fetch = o.fetch ?? fetch;
		this.#timeoutMs = o.timeoutMs ?? 35_000;
		this.#staleAfterS = o.staleAfterS ?? 15;
	}

	/** Internal URL of the live instance that holds the machine's connected session. */
	async #owner(machineId: string): Promise<string | undefined> {
		const r = await this.#pool.query<{ internal_url: string }>(
			`SELECT g.internal_url
			 FROM tunnel.tunnel_sessions s
			 JOIN tunnel.gateway_instances g ON g.id = s.instance_id
			 WHERE s.machine_id = $1 AND s.state = 'connected'
			   AND g.heartbeat_at > now() - make_interval(secs => $2)
			 ORDER BY s.epoch DESC LIMIT 1`,
			[machineId, this.#staleAfterS],
		);
		return r.rows[0]?.internal_url;
	}

	/**
	 * `POST <internal_url>/v1/machines/{id}/rotate-token`. No owner, a moved
	 * route (404, 410, 421), a connection error or 5xx are transient
	 * (`GatewayUnavailable`); 401, 403 and other 4xx are a permanent
	 * `GatewayRejected`.
	 */
	async rotateToken(machineId: string): Promise<void> {
		const base = await this.#owner(machineId);
		if (base === undefined)
			throw new GatewayUnavailable(
				`machine ${machineId} has no connected tunnel on a live gateway instance`,
			);
		const url = `${base.replace(/\/+$/, "")}/v1/machines/${encodeURIComponent(machineId)}/rotate-token`;
		let res: Response;
		try {
			res = await this.#fetch(url, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.#token}` },
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (err) {
			throw new GatewayUnavailable(
				`rotate-token for machine ${machineId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (res.ok) {
			await res.body?.cancel();
			return;
		}
		const code = await errorCode(res);
		const what = `rotate-token for machine ${machineId}: HTTP ${res.status}${code ? ` ${code}` : ""}`;
		if (res.status >= 500 || TRANSIENT_4XX.has(res.status))
			throw new GatewayUnavailable(what);
		throw new GatewayRejected(
			code ?? (res.status === 401 ? "unauthenticated" : `http_${res.status}`),
			what,
		);
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
