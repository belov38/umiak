// Process logger of the MCP server (S11 11.4): pino, never on stdout (stdio
// carries JSON-RPC there), with the secret-bearing fields redacted.
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger } from "pino";

/** Tool arguments and headers that may carry secrets, one level down. */
export const REDACT_PATHS: string[] = [
	"*.content",
	"*.old_text",
	"*.new_text",
	"*.text",
	"*.env",
	"*.command",
	"*.authorization",
	"req.headers.authorization",
];

export interface LoggerOptions {
	/** pino level; default `info`. */
	level?: string;
	/** A stream or a file path; default stderr. */
	destination?: DestinationStream | string;
}

export function createLogger(o: LoggerOptions = {}): Logger {
	const destination =
		typeof o.destination === "string"
			? pino.destination({ dest: o.destination, mkdir: true, sync: true })
			: (o.destination ?? pino.destination({ dest: 2, sync: true }));
	return pino(
		{
			level: o.level ?? "info",
			name: "umiak-mcp",
			redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		},
		destination,
	);
}

export type FetchFn = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * fetch that logs every API call at debug (S11 13.3, `--log-level debug`):
 * method, path, status, duration. Never the query, headers or bodies. The
 * request is passed on untouched (the SDK holds its own Request object).
 */
export function apiCallLogger(f: FetchFn, log: Logger): FetchFn {
	return async (input, init) => {
		if (!log.isLevelEnabled("debug")) return f(input, init);
		const req = input instanceof Request ? input : undefined;
		const fields = {
			method: (init?.method ?? req?.method ?? "GET").toUpperCase(),
			path: new URL(req?.url ?? String(input)).pathname,
		};
		const started = performance.now();
		const durationMs = () => Math.round(performance.now() - started);
		try {
			const res = await f(input, init);
			log.debug(
				{ ...fields, status: res.status, durationMs: durationMs() },
				"api call",
			);
			return res;
		} catch (err) {
			const error = err instanceof Error ? err.name : typeof err;
			log.debug(
				{ ...fields, error, durationMs: durationMs() },
				"api call failed",
			);
			throw err;
		}
	};
}
