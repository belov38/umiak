// GET /v1/meta (S7 §13): platform facts for clients, without auth.
import { createRoute, z } from "@hono/zod-openapi";
import type { ApiApp, ApiDeps } from "../deps.ts";
import { ERROR_RESPONSES, jsonResponse, NO_AUTH } from "../openapi/registry.ts";

/** Public client of the CLI device flow; also used by the SDK and MCP. */
export const OIDC_CLI_CLIENT_ID = "sbx-cli";

export const MetaSchema = z
	.object({
		apiVersion: z.string().openapi({ example: "v1" }),
		build: z
			.string()
			.openapi({ description: "Build of the api", example: "1.4.0+3f2c1a9" }),
		appUrl: z.url().openapi({ example: "https://app.example.com" }),
		apiUrl: z.url().openapi({ example: "https://api.example.com" }),
		sbxDomain: z.string().openapi({
			description:
				"Domain of published ports: https://<slug>-<port>.<sbxDomain>",
			example: "sbx.example.com",
		}),
		oidc: z
			.object({
				issuer: z.url(),
				clientId: z.string().openapi({ example: OIDC_CLI_CLIENT_ID }),
				audience: z.string().openapi({ example: "sbx-api" }),
			})
			.nullable()
			.openapi({
				description:
					"Keycloak for people (device flow of `sbx login`); null when only team keys work",
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
		"the Keycloak issuer for `sbx login`, the SSH endpoint with its host keys, and CLI versions. " +
		"Needs no authentication; clients call it first to configure themselves.",
	tags: ["meta"],
	security: NO_AUTH,
	responses: {
		200: jsonResponse(MetaSchema, "Platform information"),
		...ERROR_RESPONSES,
	},
});

export function metaOf(deps: ApiDeps): Meta {
	const s = deps.settings;
	return {
		apiVersion: "v1",
		build: s.build,
		appUrl: s.appUrl,
		apiUrl: s.apiUrl,
		sbxDomain: s.sbxDomain,
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

export function registerMetaRoutes(app: ApiApp, deps: ApiDeps): void {
	const meta = metaOf(deps);
	app.openapi(getMeta, (c) => c.json(meta, 200));
}
