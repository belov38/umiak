// Graceful stop of an api instance (S7 §9.7 item 3, Review Focus 5). On
// SIGTERM:
//   1. readiness goes false (`/readyz` 503 `shutting_down`) and every new
//      request on public, proxied and internal is 503 `server_shutting_down`;
//   2. the stream registry closes every open connection: NDJSON streams end
//      with `reconnect {reason: server_shutdown}`, PTYs get the control frame
//      `reconnect` and close 1012, sync requests answer 503 (retryable only
//      with an Idempotency-Key, else `details {commandId, outcome}`);
//   3. the listeners stop accepting and in-flight requests may finish;
//   4. at the deadline whatever still hangs is cut, and the process resources
//      (LISTEN connections, pg-boss, pools) are released.
// The whole stop takes at most SHUTDOWN_GRACE_MS (10 s); the pod grace
// period is 30 s.
import type { Server } from "node:http";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { WebSocketServer } from "ws";
import type { StreamRegistry } from "./commands/registry.ts";
import type { ApiEnv } from "./deps.ts";
import { ApiError } from "./http/errors.ts";

/** Upper bound of a graceful stop, from the signal to the resolved close. */
export const SHUTDOWN_GRACE_MS = 10_000;

/** Part of the grace period kept for releasing the process resources. */
const DISPOSE_RESERVE_MS = 1000;

/** Whether this instance is stopping; shared by the listener apps. */
export class ApiLifecycle {
	#shuttingDown = false;

	get shuttingDown(): boolean {
		return this.#shuttingDown;
	}

	beginShutdown(): void {
		this.#shuttingDown = true;
	}
}

/** New requests of a stopping instance: 503 server_shutting_down (retryable). */
export function refuseWhileShuttingDown(
	lifecycle: ApiLifecycle,
): MiddlewareHandler<ApiEnv> {
	return async (_c, next) => {
		if (lifecycle.shuttingDown) {
			throw new ApiError(
				503,
				"server_shutting_down",
				"this api instance is shutting down; retry the request",
				{ retryable: true },
			);
		}
		await next();
	};
}

/** A listener of the process and its WebSocket server (public, proxied). */
export interface Listener {
	name: string;
	server: Server;
	wss?: WebSocketServer;
}

export interface ShutdownInput {
	lifecycle: ApiLifecycle;
	streams: StreamRegistry;
	/** Request listeners (public, proxied, internal); they stop first. */
	listeners: Listener[];
	/** The ops listener: `/readyz` answers 503 until the very end. */
	ops: Listener | null;
	/** Releases the process resources (pools, LISTEN, pg-boss). */
	dispose: () => Promise<void>;
	log: Logger;
	graceMs?: number;
}

const delay = (ms: number) =>
	new Promise<void>((r) => setTimeout(r, Math.max(0, ms)).unref());

/** How often keep-alive connections that went idle are closed while draining. */
const IDLE_SWEEP_MS = 50;

function closed(l: Listener): Promise<void> {
	return new Promise((resolve) => {
		if (!l.server.listening) {
			resolve();
			return;
		}
		// `close` reaps the connections idle right now; the ones finishing a
		// response go idle later and would otherwise stay until the keep-alive
		// timeout.
		const sweep = setInterval(
			() => l.server.closeIdleConnections(),
			IDLE_SWEEP_MS,
		);
		sweep.unref();
		l.server.close(() => {
			clearInterval(sweep);
			resolve();
		});
		l.server.closeIdleConnections();
	});
}

function wsDrained(l: Listener): Promise<void> {
	const wss = l.wss;
	if (wss === undefined) return Promise.resolve();
	return new Promise((resolve) => {
		const t = setInterval(() => {
			if (wss.clients.size === 0) {
				clearInterval(t);
				resolve();
			}
		}, 20);
		t.unref();
		if (wss.clients.size === 0) {
			clearInterval(t);
			resolve();
		}
	});
}

function cut(l: Listener): void {
	for (const ws of l.wss?.clients ?? []) ws.terminate();
	l.wss?.close();
	l.server.closeAllConnections();
}

/** Steps 1-4 above; resolves within `graceMs` (default 10 s). */
export async function shutdown(i: ShutdownInput): Promise<void> {
	const started = Date.now();
	const grace = i.graceMs ?? SHUTDOWN_GRACE_MS;
	const drainDeadline = started + Math.max(0, grace - DISPOSE_RESERVE_MS);
	const left = () => Math.max(0, drainDeadline - Date.now());

	i.lifecycle.beginShutdown();
	i.log.info({ open: i.streams.size }, "shutting down: closing open streams");
	await i.streams.closeAll("server_shutdown", left());
	if (i.streams.size > 0) {
		i.log.warn(
			{ open: i.streams.size },
			"shutting down: streams did not close in time",
		);
	}

	// PTY sockets finish their close handshake; requests in flight finish.
	const drained = Promise.all(
		i.listeners.map((l) => Promise.all([closed(l), wsDrained(l)])),
	);
	const inTime = await Promise.race([
		drained.then(() => true),
		delay(left()).then(() => false),
	]);
	if (!inTime) {
		i.log.warn("shutting down: cutting connections that are still open");
	}
	for (const l of i.listeners) cut(l);
	if (i.ops !== null) {
		void closed(i.ops);
		cut(i.ops);
	}

	const disposed = await Promise.race([
		i.dispose().then(
			() => true,
			(err: unknown) => {
				i.log.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"shutting down: releasing resources failed",
				);
				return true;
			},
		),
		delay(started + grace - Date.now()).then(() => false),
	]);
	if (!disposed) i.log.warn("shutting down: resources not released in time");
	i.log.info({ ms: Date.now() - started }, "shut down");
}

/** The process events the signal handling needs (`process` in production). */
export interface SignalSource {
	on(event: "SIGTERM" | "SIGINT", fn: () => void): unknown;
}

/**
 * SIGTERM/SIGINT: one graceful `close`, then `exit(0)` (1 if it failed). A
 * second signal exits 1 at once.
 */
export function onShutdownSignals(
	proc: SignalSource,
	o: {
		close: () => Promise<void>;
		exit: (code: number) => void;
		log?: Logger;
	},
): void {
	let stopping = false;
	const handle = (signal: string) => {
		if (stopping) {
			o.log?.warn({ signal }, "second signal: exiting now");
			o.exit(1);
			return;
		}
		stopping = true;
		o.log?.info({ signal }, "signal: shutting down");
		o.close().then(
			() => o.exit(0),
			(err: unknown) => {
				o.log?.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"shutdown failed",
				);
				o.exit(1);
			},
		);
	};
	proc.on("SIGTERM", () => handle("SIGTERM"));
	proc.on("SIGINT", () => handle("SIGINT"));
}
