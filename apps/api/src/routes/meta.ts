// Routes without auth on the public and proxied listeners: GET /v1/meta
// (S7 §13, platform facts for clients), GET /v1/openapi.json, and GET
// /v1/docs (S7 §15.1) on the public listener only: the page loads Scalar
// from a CDN, which must not run on the cookie-authenticated proxied origin.
import { createRoute, z } from "@hono/zod-openapi";
import type { ApiApp, ApiDeps } from "../deps.ts";
import {
	buildOpenApiDocument,
	type OpenApiDocument,
} from "../openapi/document.ts";
import { ERROR_RESPONSES, jsonResponse, NO_AUTH } from "../openapi/registry.ts";

/**
 * Route templates that need no authentication on the public and proxied
 * listeners; they are exactly the operations with `security: []` (the
 * drift test checks this).
 */
export const ANONYMOUS_ROUTES: ReadonlySet<string> = new Set([
	"/v1/meta",
	"/v1/openapi.json",
]);

export const MetaSchema = z
	.object({
		authMode: z.enum(["owner"]).optional(),
		tenancy: z.enum(["single", "teams"]).optional().openapi({
			description:
				"Presentation model for this deployment. Missing on older servers means teams; independent of credential kind.",
		}),
		apiVersion: z.string().openapi({ example: "v1" }),
		build: z
			.string()
			.openapi({ description: "Build of the api", example: "1.4.0+3f2c1a9" }),
		appUrl: z.url().openapi({ example: "https://app.example.com" }),
		apiUrl: z.url().openapi({ example: "https://api.example.com" }),
		umiakDomain: z.string().openapi({
			description:
				"Domain of published ports: <previewScheme>://<slug>-<port>.<umiakDomain>[:previewPort]",
			example: "umiak.example.com",
		}),
		previewScheme: z.enum(["http", "https"]).optional().openapi({
			description:
				"Scheme of published port URLs; absent on older servers means https",
		}),
		previewPort: z.number().int().min(1).max(65535).optional().openapi({
			description:
				"Public preview listener port; omit from URLs when it is the scheme default",
		}),
		ssh: z.object({
			host: z.string().openapi({ example: "ssh.example.com" }),
			port: z.int().min(1).max(65535),
			hostKeys: z.array(z.string()).openapi({
				description: 'Gateway host keys for known_hosts, "<type> <base64>"',
			}),
		}),
		minCliVersion: z.string().nullable().openapi({
			description: "Older CLIs warn and keep working",
			example: "0.4.0",
		}),
		latestCliVersion: z.string().nullable().openapi({ example: "0.5.1" }),
	})
	.openapi("Meta");

export type Meta = z.infer<typeof MetaSchema>;

const getMeta = createRoute({
	method: "get",
	path: "/v1/meta",
	operationId: "meta.get",
	summary: "Platform information",
	description:
		"Public facts about this deployment: API and dashboard URLs, the domain of published ports, " +
		"owner authentication, the SSH endpoint with its host keys, and CLI versions. " +
		"Needs no authentication; clients call it first to configure themselves.",
	tags: ["meta"],
	security: NO_AUTH,
	responses: {
		200: jsonResponse(MetaSchema, "Platform information"),
		...ERROR_RESPONSES,
	},
});

const getOpenApi = createRoute({
	method: "get",
	path: "/v1/openapi.json",
	operationId: "meta.openapi",
	summary: "OpenAPI document",
	description:
		"This OpenAPI 3.1 document, with the server URL of this deployment. " +
		"Needs no authentication. SDKs are generated from it.",
	tags: ["meta"],
	security: NO_AUTH,
	responses: {
		200: jsonResponse(
			z.record(z.string(), z.unknown()),
			"OpenAPI 3.1 document",
		),
		...ERROR_RESPONSES,
	},
});

export function metaOf(deps: ApiDeps): Meta {
	const s = deps.settings;
	return {
		authMode: "owner",
		tenancy: "single",
		apiVersion: "v1",
		build: s.build,
		appUrl: s.appUrl,
		apiUrl: s.apiUrl,
		umiakDomain: s.umiakDomain,
		previewScheme: s.previewScheme,
		previewPort: s.previewPort,
		ssh: { host: s.sshHost, port: s.sshPort, hostKeys: deps.hostKeys },
		minCliVersion: s.minCliVersion,
		latestCliVersion: s.latestCliVersion,
	};
}

export interface MetaRouteOptions {
	/** Serve GET /v1/docs (the public listener only). */
	docs: boolean;
}

export function registerMetaRoutes(
	app: ApiApp,
	deps: ApiDeps,
	_o: MetaRouteOptions = { docs: true },
): void {
	const meta = metaOf(deps);
	app.openapi(getMeta, (c) => c.json(meta, 200));

	let doc: OpenApiDocument | undefined;
	app.openapi(getOpenApi, (c) => {
		doc ??= buildOpenApiDocument(app, {
			apiUrl: deps.settings.apiUrl,
		});
		return c.json(doc, 200);
	});
}
