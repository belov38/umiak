// The OpenAPI 3.1 document of the public API, generated from the routes of
// the public app. The committed `openapi/v1.json` uses placeholder URLs; the
// document served at `/v1/openapi.json` carries the deployment's.
import type { ApiApp } from "../deps.ts";
import {
	DEFAULT_SECURITY,
	DOC_API_URL_PLACEHOLDER,
	DOC_ISSUER_PLACEHOLDER,
	openIdConnectUrl,
} from "./registry.ts";

export interface DocumentUrls {
	apiUrl: string;
	/** Keycloak issuer; null keeps the placeholder. */
	issuer: string | null;
}

export type OpenApiDocument = Record<string, unknown>;

const DESCRIPTION = [
	"API of sbx: VM sandboxes for AI agents on Proxmox VE.",
	"",
	"Errors always have the shape {error: {code, message, retryable, details, requestId}}.",
	"Every response carries a Request-Id header.",
].join("\n");

export function buildOpenApiDocument(
	app: ApiApp,
	urls: DocumentUrls = {
		apiUrl: DOC_API_URL_PLACEHOLDER,
		issuer: DOC_ISSUER_PLACEHOLDER,
	},
): OpenApiDocument {
	const doc = app.getOpenAPI31Document({
		openapi: "3.1.0",
		info: { title: "sbx API", version: "v1", description: DESCRIPTION },
		servers: [{ url: urls.apiUrl }],
		security: DEFAULT_SECURITY,
	}) as unknown as OpenApiDocument;
	const schemes = (
		doc.components as {
			securitySchemes?: { keycloak?: { openIdConnectUrl?: string } };
		}
	)?.securitySchemes;
	if (urls.issuer !== null && schemes?.keycloak) {
		schemes.keycloak.openIdConnectUrl = openIdConnectUrl(urls.issuer);
	}
	return doc;
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v !== null && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) {
			out[k] = sortKeys((v as Record<string, unknown>)[k]);
		}
		return out;
	}
	return v;
}

/** Stable text of the committed file: sorted keys, tabs, trailing newline. */
export function serializeOpenApiDocument(doc: OpenApiDocument): string {
	return `${JSON.stringify(sortKeys(doc), null, "\t")}\n`;
}
