// Process logging: pino to stdout with the secret redaction of
// `createLogger` (global constraints), and error helpers for log fields.
import type { Logger } from "pino";
import { createLogger } from "./context.ts";

export function processLogger(
	level: string,
	name: "umiak-worker" | "umiak-admin" = "umiak-worker",
): Logger {
	return createLogger({ level, name });
}

/** Message of any thrown value (infra errors are already scrubbed, 13a). */
export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** `{err, code?}` log fields of a thrown value; never the cause chain. */
export function errFields(err: unknown): { err: string; code?: string } {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string"
		? { err: errText(err), code }
		: { err: errText(err) };
}
