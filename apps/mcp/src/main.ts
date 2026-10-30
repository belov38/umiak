// Remote MCP server process: `node src/main.ts`. Reads the environment
// (settings.ts), serves /mcp on SBX_MCP_PORT (8080) and /metrics on
// SBX_MCP_OPS_PORT (9090), and stops on SIGTERM/SIGINT within 10 s:
// readiness goes false, new connections stop, calls in flight get the rest
// of the grace period, then whatever still hangs is cut (clients retry,
// S11 6.2).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createHttpApp, createOpsApp } from "./http/app.ts";
import { createLogger, type Logger } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { loadSettings, type Settings } from "./settings.ts";

/** Upper bound of a graceful stop, from the signal to the resolved close. */
export const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningMcp {
	port: number;
	opsPort: number;
	close(): Promise<void>;
}

function listen(app: Hono, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const s = serve({ fetch: app.fetch, port }, () => resolve(s as Server));
		s.once("error", reject);
	});
}

function closed(s: Server, deadline: number): Promise<void> {
	return new Promise((resolve) => {
		const cut = setTimeout(
			() => s.closeAllConnections(),
			Math.max(0, deadline - Date.now()),
		);
		cut.unref();
		// Idle keep-alive connections go now, the busy ones once they finish.
		const sweep = setInterval(() => s.closeIdleConnections(), 50);
		sweep.unref();
		s.close(() => {
			clearTimeout(cut);
			clearInterval(sweep);
			resolve();
		});
		s.closeIdleConnections();
	});
}

export async function startMcp(
	settings: Settings,
	o: { log: Logger; graceMs?: number },
): Promise<RunningMcp> {
	const metrics = new Metrics();
	const http = createHttpApp({
		apiUrl: settings.apiUrl,
		publicUrl: settings.publicUrl,
		issuer: settings.issuer,
		allowedHosts: settings.allowedHosts,
		allowedOrigins: settings.allowedOrigins,
		log: o.log,
		metrics,
	});
	let stopping = false;
	const main = await listen(http.app, settings.port);
	const ops = await listen(
		createOpsApp({ metrics, ready: () => !stopping && http.ready() }),
		settings.opsPort,
	);
	const port = (main.address() as AddressInfo).port;
	const opsPort = (ops.address() as AddressInfo).port;
	o.log.info({ port, opsPort, publicUrl: settings.publicUrl }, "mcp listening");
	return {
		port,
		opsPort,
		async close() {
			stopping = true;
			const deadline = Date.now() + (o.graceMs ?? SHUTDOWN_GRACE_MS) - 500;
			const draining = closed(main, deadline);
			// In-flight calls finish until the deadline; then their exchanges
			// are torn down and the connections cut.
			const left = Math.max(0, deadline - Date.now());
			await Promise.race([
				draining,
				new Promise((r) => setTimeout(r, left).unref()),
			]);
			await http.close();
			await draining;
			await closed(ops, Date.now());
		},
	};
}

async function main(): Promise<void> {
	let settings: Settings;
	try {
		settings = loadSettings(process.env);
	} catch (err) {
		process.stderr.write(
			`sbx-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}
	const log = createLogger({ level: settings.logLevel });
	process.on("unhandledRejection", (reason) => {
		log.error(
			{ err: reason instanceof Error ? reason.message : String(reason) },
			"unhandled rejection",
		);
	});
	let running: RunningMcp;
	try {
		running = await startMcp(settings, { log });
	} catch (err) {
		log.fatal(
			{ err: err instanceof Error ? err.message : String(err) },
			"mcp failed to start",
		);
		process.exit(1);
	}
	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) {
			log.warn({ signal }, "second signal: exiting now");
			process.exit(1);
		}
		stopping = true;
		log.info({ signal }, "signal: shutting down");
		const hard = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
		hard.unref();
		running.close().then(
			() => process.exit(0),
			(err: unknown) => {
				log.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"shutdown failed",
				);
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
}

if (import.meta.main) await main();
