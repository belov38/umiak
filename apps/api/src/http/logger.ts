// Process logger (pino to stdout) with the secret redaction of the global
// constraints, and the per-request log line.
import type { MiddlewareHandler } from "hono";
import pino, { type DestinationStream, type Logger } from "pino";
import type { ApiEnv } from "../deps.ts";
import { routeLabel } from "./metrics.ts";

/**
 * Secret-bearing fields: the bearer, env, secrets, secret files, API key
 * secrets, port tokens, SSO codes and base64 file contents. Top level and
 * one level down.
 */
export const REDACT_PATHS: string[] = [
	"req.headers.authorization",
	"headers.authorization",
	"env",
	"secrets",
	"secretFiles",
	"secret",
	"token",
	"contentBase64",
	"*.env",
	"*.secrets",
	"*.secretFiles",
	"*.secret",
	"*.token",
	"*.code",
	"*.contentBase64",
];

export function createApiLogger(
	opts: { level?: string } = {},
	destination?: DestinationStream,
): Logger {
	const options = {
		level: opts.level ?? "info",
		name: "sbx-api",
		redact: { paths: REDACT_PATHS, censor: "[redacted]" },
	};
	return destination ? pino(options, destination) : pino(options);
}

/**
 * One `request` line per request after the response is ready: request ids,
 * client address, method, path (without the query: it may carry tokens),
 * route template, status, error code and duration.
 */
export function requestLog(log: Logger): MiddlewareHandler<ApiEnv> {
	return async (c, next) => {
		const started = performance.now();
		await next();
		const status = c.res.status;
		const fields: Record<string, unknown> = {
			requestId: c.var.requestId,
			method: c.req.method,
			path: c.req.path,
			route: routeLabel(c),
			status,
			durationMs: Math.round((performance.now() - started) * 10) / 10,
		};
		if (c.var.clientIp !== undefined) fields.clientIp = c.var.clientIp;
		if (c.var.clientRequestId !== undefined) {
			fields.clientRequestId = c.var.clientRequestId;
		}
		if (c.var.errorCode !== undefined) fields.code = c.var.errorCode;
		if (status >= 500) log.warn(fields, "request");
		else log.info(fields, "request");
	};
}
