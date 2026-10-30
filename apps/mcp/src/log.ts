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
			name: "sbx-mcp",
			redact: { paths: REDACT_PATHS, censor: "[redacted]" },
		},
		destination,
	);
}
