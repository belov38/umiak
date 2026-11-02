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
	"/v1/docs",
]);

/** Public client of the CLI device flow; also used by the SDK and MCP. */
export const OIDC_CLI_CLIENT_ID = "umiak-cli";

export const MetaSchema = z
	.object({
		authMode: z.enum(["oidc", "none"]).optional(),
		apiVersion: z.string().openapi({ example: "v1" }),
		build: z
			.string()
			.openapi({ description: "Build of the api", example: "1.4.0+3f2c1a9" }),
		appUrl: z.url().openapi({ example: "https://app.example.com" }),
		apiUrl: z.url().openapi({ example: "https://api.example.com" }),
		umiakDomain: z.string().openapi({
			description:
				"Domain of published ports: https://<slug>-<port>.<umiakDomain>",
			example: "umiak.example.com",
		}),
		oidc: z
			.object({
				issuer: z.url(),
				clientId: z.string().openapi({ example: OIDC_CLI_CLIENT_ID }),
				audience: z.string().openapi({ example: "umiak-api" }),
			})
			.nullable()
			.openapi({
				description:
					"Keycloak for people (device flow of `umiak login`); null when only team keys work",
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
		"the Keycloak issuer for `umiak login`, the SSH endpoint with its host keys, and CLI versions. " +
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
		"This OpenAPI 3.1 document, with the server URL and Keycloak issuer of this deployment. " +
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

const getDocs = createRoute({
	method: "get",
	path: "/v1/docs",
	operationId: "meta.docs",
	summary: "API reference page",
	description:
		"Interactive HTML reference (Scalar, pinned with SRI) rendered from `/v1/openapi.json`. Needs no " +
		"authentication. Public listener only.",
	tags: ["meta"],
	security: NO_AUTH,
	responses: {
		200: {
			description: "HTML page",
			content: { "text/html": { schema: z.string() } },
		},
		...ERROR_RESPONSES,
	},
});

export function metaOf(deps: ApiDeps): Meta {
	const s = deps.settings;
	return {
		...(s.authMode === "none" ? { authMode: "none" as const } : {}),
		apiVersion: "v1",
		build: s.build,
		appUrl: s.appUrl,
		apiUrl: s.apiUrl,
		umiakDomain: s.umiakDomain,
		oidc:
			s.oidc === null
				? null
				: {
						issuer: s.oidc.issuer,
						clientId: OIDC_CLI_CLIENT_ID,
						audience: s.oidc.audience,
					},
		ssh: { host: s.sshHost, port: s.sshPort, hostKeys: deps.hostKeys },
		minCliVersion: s.minCliVersion,
		latestCliVersion: s.latestCliVersion,
	};
}

/**
 * The Scalar standalone bundle: an exact version with its SRI hash
 * (sha384 of dist/browser/standalone.js of @scalar/api-reference 1.76.3),
 * so a changed file on the CDN does not run. Bundling it would add the
 * package's whole dependency tree (Vue and ~30 packages) to the api.
 */
const SCALAR_BUNDLE =
	"https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.3/dist/browser/standalone.js";
const SCALAR_BUNDLE_SRI =
	"sha384-H/jJ+XQ0S+5wKmVCrODlHKRKyDzdSBog4sUPc+AQTZddtU1FyQsiCrA47EUte2Fd";

/**
 * Only the pinned bundle runs (no inline script, no eval); it injects its
 * styles; the document and "try it" calls go to this origin.
 */
const DOCS_CSP = [
	"default-src 'none'",
	`script-src ${SCALAR_BUNDLE}`,
	"style-src 'unsafe-inline'",
	"img-src 'self' data:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");

const DOCS_CONFIG = JSON.stringify({ withDefaultFonts: false });

// Relative URL: works under /v1/docs and behind a path prefix. The first
// script element only holds the configuration (type application/json).
const DOCS_HTML = `<!doctype html>
<html>
  <head>
    <title>umiak API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" type="application/json" data-url="openapi.json" data-configuration="${DOCS_CONFIG.replaceAll('"', "&quot;")}"></script>
    <script src="${SCALAR_BUNDLE}" integrity="${SCALAR_BUNDLE_SRI}" crossorigin="anonymous"></script>
  </body>
</html>
`;

export interface MetaRouteOptions {
	/** Serve GET /v1/docs (the public listener only). */
	docs: boolean;
}

export function registerMetaRoutes(
	app: ApiApp,
	deps: ApiDeps,
	o: MetaRouteOptions = { docs: true },
): void {
	const meta = metaOf(deps);
	app.openapi(getMeta, (c) => c.json(meta, 200));

	let doc: OpenApiDocument | undefined;
	app.openapi(getOpenApi, (c) => {
		doc ??= buildOpenApiDocument(app, {
			apiUrl: deps.settings.apiUrl,
			issuer: deps.settings.oidc?.issuer ?? null,
		});
		return c.json(doc, 200);
	});

	if (!o.docs || deps.settings.authMode === "none") return;
	app.openapi(getDocs, (c) =>
		c.html(DOCS_HTML, 200, { "Content-Security-Policy": DOCS_CSP }),
	);
}
