// Shared OpenAPI pieces: the Error component, response helpers, security
// schemes and requirements (S7 §15.1). Route modules import `z` from
// `@hono/zod-openapi` (zod with `.openapi()`), never from `zod` directly.
import { z } from "@hono/zod-openapi";
import type { ApiApp } from "../deps.ts";

/** Placeholder values of the committed document; the served one is filled from settings. */
export const DOC_ISSUER_PLACEHOLDER = "https://auth.example.com/realms/sbx";
export const DOC_API_URL_PLACEHOLDER = "https://api.example.com";

export const ErrorSchema = z
	.object({
		error: z.object({
			code: z.string().openapi({
				description:
					"Stable snake_case error code; new codes may be added within v1",
				example: "operation_in_progress",
			}),
			message: z.string().openapi({
				description: "What happened and what to do next, in English",
			}),
			retryable: z.boolean().openapi({
				description: "Repeating the same request is safe and may succeed later",
			}),
			details: z.record(z.string(), z.unknown()).openapi({
				description: "Code-specific details; may be empty",
			}),
			requestId: z
				.string()
				.openapi({ example: "req_01jbx2v7d3m6c8q9w0e4r5t6y7" }),
		}),
	})
	.openapi("Error", {
		description: "Error envelope of every non-2xx response (S7 §5.5)",
	});

const JSON_TYPE = "application/json";

/** JSON response object for `createRoute({responses})`. */
export function jsonResponse<T extends z.ZodType>(
	schema: T,
	description: string,
) {
	return { description, content: { [JSON_TYPE]: { schema } } } as const;
}

/** JSON request body for `createRoute({request: {body}})`. */
export function jsonBody<T extends z.ZodType>(schema: T, description: string) {
	return {
		description,
		required: true,
		content: { [JSON_TYPE]: { schema } },
	} as const;
}

/** An error response with a description of when it happens. */
export function errorResponse(description: string) {
	return jsonResponse(ErrorSchema, description);
}

/**
 * Spread into every route's `responses`: any status may carry an error
 * (auth, rate limits, internal). Specific statuses with their own
 * description go next to it via `errorResponse`.
 */
export const ERROR_RESPONSES = {
	default: errorResponse("Error; `error.code` says what happened"),
} as const;

/**
 * Response enum: closed for our validation, marked open for clients (v1
 * only adds values, S7 §5.9).
 */
export function extensibleEnum<const T extends readonly [string, ...string[]]>(
	values: T,
) {
	return z.enum(values).openapi({ "x-extensible-enum": true });
}

/** Operations without authentication (`/v1/meta`). */
export const NO_AUTH: { [name: string]: string[] }[] = [];
/** Operations only for a person (SSH keys, issuing keys): Keycloak JWT. */
export const HUMAN_ONLY: { [name: string]: string[] }[] = [{ keycloak: [] }];
/** Default for every operation, set at the document level. */
export const DEFAULT_SECURITY: { [name: string]: string[] }[] = [
	{ keycloak: [] },
	{ teamKey: [] },
];

/** Discovery URL of the `keycloak` scheme for an issuer. */
export function openIdConnectUrl(issuer: string): string {
	return `${issuer}/.well-known/openid-configuration`;
}

export function registerSecuritySchemes(app: ApiApp): void {
	app.openAPIRegistry.registerComponent("securitySchemes", "keycloak", {
		type: "openIdConnect",
		openIdConnectUrl: openIdConnectUrl(DOC_ISSUER_PLACEHOLDER),
		description: "Keycloak access token of a person (CLI, SDK, MCP)",
	});
	app.openAPIRegistry.registerComponent("securitySchemes", "teamKey", {
		type: "http",
		scheme: "bearer",
		bearerFormat: "sbx_",
		description: "Team API key (sbx_...) for automation and CI",
	});
}
