// Probe and metrics endpoints of the worker (S6 §15.2), plain node:http:
//   GET /healthz  liveness: the event loop is not stuck
//   GET /readyz   readiness: pg-boss started, Postgres answers, migrations applied
//   GET /metrics  Prometheus text format
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";

export interface Readiness {
	ready: boolean;
	/** Why not ready; empty when ready. */
	reasons: string[];
}

export interface Liveness {
	ok: boolean;
	/** How late the last event-loop tick was, in ms. */
	lagMs: number;
}

export interface HttpHandlers {
	liveness(): Liveness;
	readiness(): Promise<Readiness>;
	metrics(): Promise<{ contentType: string; body: string }>;
	log: Logger;
}

function send(
	res: http.ServerResponse,
	status: number,
	type: string,
	body: string,
): void {
	res.writeHead(status, {
		"content-type": type,
		"cache-control": "no-store",
	});
	res.end(body);
}

const json = (res: http.ServerResponse, status: number, body: unknown) =>
	send(res, status, "application/json", JSON.stringify(body));

export function createHttpServer(h: HttpHandlers): http.Server {
	const server = http.createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		if (req.method !== "GET" && req.method !== "HEAD") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		const run = async () => {
			switch (path) {
				case "/healthz": {
					const l = h.liveness();
					json(res, l.ok ? 200 : 503, l);
					return;
				}
				case "/readyz": {
					const r = await h.readiness();
					json(res, r.ready ? 200 : 503, r);
					return;
				}
				case "/metrics": {
					const m = await h.metrics();
					send(res, 200, m.contentType, m.body);
					return;
				}
				default:
					json(res, 404, { error: "not found" });
			}
		};
		run().catch((err: unknown) => {
			h.log.error(
				{ path, err: err instanceof Error ? err.message : String(err) },
				"http handler failed",
			);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
			else res.destroy();
		});
	});
	// Probes are short; never let a slow client hold a socket.
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.keepAliveTimeout = 5_000;
	return server;
}

/** Listens and returns the bound port (port 0 picks a free one). */
export function listen(
	server: http.Server,
	port: number,
	host?: string,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const onError = (err: Error) => reject(err);
		server.once("error", onError);
		server.listen(port, host, () => {
			server.off("error", onError);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

export function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

/**
 * Event-loop liveness: a timer ticks every `intervalMs`; when a tick is more
 * than `maxLagMs` late the loop was blocked. A loop stuck for good cannot
 * answer the probe at all, which fails it by timeout.
 */
export class LoopMonitor {
	readonly #intervalMs: number;
	readonly #maxLagMs: number;
	#last = Date.now();
	#lagMs = 0;
	#timer: NodeJS.Timeout | undefined;

	constructor(intervalMs = 1000, maxLagMs = 5000) {
		this.#intervalMs = intervalMs;
		this.#maxLagMs = maxLagMs;
	}

	start(): void {
		if (this.#timer) return;
		this.#last = Date.now();
		this.#timer = setInterval(() => {
			const now = Date.now();
			this.#lagMs = Math.max(0, now - this.#last - this.#intervalMs);
			this.#last = now;
		}, this.#intervalMs);
		this.#timer.unref();
	}

	stop(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
	}

	liveness(): Liveness {
		// A tick that is overdue right now counts as lag too.
		const overdue = Math.max(0, Date.now() - this.#last - this.#intervalMs);
		const lagMs = Math.max(this.#lagMs, overdue);
		return { ok: lagMs < this.#maxLagMs, lagMs };
	}
}
