// Team API keys (S7 §7.2, §13; S8 §9.8, C5). A key belongs to the team, not
// to its creator (kept for audit; leaving the team or deactivation does not
// turn the key off).
// - list: any member, or a key with keys:admin;
// - create, rotate: an owner, as a person (403 role / user_required);
// - revoke: an owner, an operator (browser session) or a key with
//   keys:admin, within the request's team (another team's key is 404);
// - revoke self: any key.
// Revocation and rotation fire NOTIFY sbx_identity 'api-keys:<id>' (the
// trigger of the store), so every pod drops the key; this pod drops it at
// once. The secret is returned only by create and rotate.
import { createRoute } from "@hono/zod-openapi";
import {
	type ApiKeyRecord,
	apiKeyDisplay,
	apiKeyHash,
	decodeUuid,
	encodeUuid,
	generateApiKeySecret,
	IdentityError,
	PRESETS,
	type Scope,
} from "@sbx/auth";
import type { Principal } from "@sbx/core";
import type { Context } from "hono";
import { authOf } from "../auth/principal.ts";
import { requireOwner, requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { ApiError, notFoundError } from "../http/errors.ts";
import { iso, isoOrNull } from "../map/operation.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	HUMAN_ONLY,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import {
	ApiKeyListSchema,
	ApiKeyParams,
	type ApiKeySchema,
	ApiKeySecretSchema,
	CreateApiKeyRequest,
	DEFAULT_KEY_LIFETIME_SECONDS,
} from "../schemas/api-key.ts";

const TAGS = ["api-keys"];

const CLI_USER_AGENT_PREFIX = "sbx-cli/";

const owner403 = errorResponse(
	"`forbidden`: details.reason `role` (not an owner of the team) or `user_required` " +
		"(a team key cannot issue keys)",
);
const notFound404 = errorResponse("`not_found`: no such key in the team");

const listKeys = createRoute({
	method: "get",
	path: "/v1/api-keys",
	operationId: "apiKeys.list",
	summary: "List the team's API keys",
	description:
		"Every key of the team of the request, revoked and expired ones included, newest " +
		"first, with who created it and whether that person is still active and a member. " +
		"Secrets are never shown. Any member; a team key needs keys:admin.",
	tags: TAGS,
	middleware: [requireScope("keys:admin")] as const,
	responses: {
		200: jsonResponse(ApiKeyListSchema, "Keys of the team"),
		...ERROR_RESPONSES,
	},
});

const createKey = createRoute({
	method: "post",
	path: "/v1/api-keys",
	operationId: "apiKeys.create",
	summary: "Issue a team API key",
	description:
		"Issues a key of the team for automation and CI with `scopes` or a `preset` " +
		"(read-only, ci, full) and a lifetime (default 90 days, at most 365). The secret is " +
		"in this answer only. Only an owner of the team, as a person (dashboard or `sbx " +
		"login`); a key cannot issue keys. People use `sbx login` instead of keys.",
	tags: TAGS,
	security: HUMAN_ONLY,
	middleware: [requireOwner()] as const,
	request: { body: jsonBody(CreateApiKeyRequest, "The key") },
	responses: {
		201: jsonResponse(ApiKeySecretSchema, "Issued; the secret is shown once"),
		400: errorResponse(
			"`validation`: unknown scope or preset, both or neither of them, lifetime over 365 " +
				'days, kind other than "team"',
		),
		403: owner403,
		...ERROR_RESPONSES,
	},
});

const rotateKey = createRoute({
	method: "post",
	path: "/v1/api-keys/{key}/rotate",
	operationId: "apiKeys.rotate",
	summary: "Rotate a team API key",
	description:
		"Replaces the secret of the key: the old secret stops working at once; id, name, " +
		"scopes and expiry stay. The new secret is in this answer only. Only an owner, as a " +
		"person.",
	tags: TAGS,
	security: HUMAN_ONLY,
	middleware: [requireOwner()] as const,
	request: { params: ApiKeyParams },
	responses: {
		200: jsonResponse(ApiKeySecretSchema, "The new secret, shown once"),
		403: owner403,
		404: notFound404,
		409: errorResponse(
			"`invalid_state`: the key is revoked or expired (`details.state`)",
		),
		...ERROR_RESPONSES,
	},
});

const revokeSelf = createRoute({
	method: "delete",
	path: "/v1/api-keys/self",
	operationId: "apiKeys.revokeSelf",
	summary: "Revoke the calling key",
	description:
		"The team key of this request revokes itself (`sbx logout --revoke`); it stops " +
		"working at once on every server. Any team key, no scope needed.",
	tags: TAGS,
	responses: {
		204: { description: "Revoked" },
		403: errorResponse(
			"`forbidden` with details.reason `api_key_required`: the caller is a person",
		),
		...ERROR_RESPONSES,
	},
});

const revokeKey = createRoute({
	method: "delete",
	path: "/v1/api-keys/{key}",
	operationId: "apiKeys.revoke",
	summary: "Revoke a team API key",
	description:
		"Revokes a key of the team of the request; it stops working at once on every " +
		"server, open streams and terminals of it are closed. Repeating is safe. An owner, " +
		"a platform operator, or a team key with keys:admin.",
	tags: TAGS,
	middleware: [requireScope("keys:admin")] as const,
	request: { params: ApiKeyParams },
	responses: {
		204: { description: "Revoked" },
		403: errorResponse(
			"`forbidden`: details.reason `role` (a member) or details.requiredScope " +
				"`keys:admin` (a key without it)",
		),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

type ApiKeyView = typeof ApiKeySchema._output;

function toApiKey(k: ApiKeyRecord): ApiKeyView {
	return {
		id: encodeUuid("apiKey", k.id),
		kind: k.kind,
		sandboxId: k.sandboxId === null ? null : encodeUuid("sandbox", k.sandboxId),
		teamId: encodeUuid("team", k.teamId),
		name: k.name,
		prefix: k.prefix,
		last4: k.last4,
		scopes: [...k.scopes],
		createdBy:
			k.createdBy === null
				? null
				: { ...k.createdBy, id: encodeUuid("user", k.createdBy.id) },
		createdVia: k.createdVia,
		createdAt: iso(k.createdAt),
		expiresAt: iso(k.expiresAt),
		lastUsedAt: isoOrNull(k.lastUsedAt),
		revokedAt: isoOrNull(k.revokedAt),
	};
}

function createdVia(
	c: Context<ApiEnv>,
	p: Principal,
): ApiKeyRecord["createdVia"] {
	if (c.req.header("user-agent")?.startsWith(CLI_USER_AGENT_PREFIX)) {
		return "cli";
	}
	return p.kind === "session" ? "dashboard" : "api";
}

/** A new secret with its stored forms. */
function newSecret() {
	const secret = generateApiKeySecret();
	return { secret, secretHash: apiKeyHash(secret), ...apiKeyDisplay(secret) };
}

/** The key of the path within the request's team; else 404. */
async function teamKey(
	deps: ApiDeps,
	p: Principal,
	ref: string,
): Promise<ApiKeyRecord> {
	const id = decodeUuid("apiKey", ref);
	const k = id === null ? null : await deps.identity.apiKey(id);
	if (k === null || k.teamId !== p.teamId) throw notFoundError("api key");
	return k;
}

function revoker(p: Principal): { userId?: string; apiKeyId?: string } {
	return p.kind === "team_key"
		? { apiKeyId: p.apiKeyId as string }
		: { userId: p.userId as string };
}

function revokedError(): ApiError {
	return new ApiError(
		409,
		"invalid_state",
		"the key is revoked; issue a new one",
		{ details: { state: "revoked" } },
	);
}

function expiredError(): ApiError {
	return new ApiError(
		409,
		"invalid_state",
		"the key has expired; issue a new one",
		{ details: { state: "expired" } },
	);
}

export function registerApiKeyRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(listKeys, async (c) => {
		const p = authOf(c).principal;
		const keys = await deps.identity.listApiKeys({ teamId: p.teamId });
		return c.json({ data: keys.map(toApiKey) }, 200);
	});

	app.openapi(createKey, async (c) => {
		const p = authOf(c).principal;
		const body = c.req.valid("json");
		const scopes: Scope[] = [
			...new Set(body.scopes ?? PRESETS[body.preset as keyof typeof PRESETS]),
		];
		const lifetime = body.expiresInSeconds ?? DEFAULT_KEY_LIFETIME_SECONDS;
		const { secret, ...stored } = newSecret();
		const k = await deps.identity.createApiKey({
			teamId: p.teamId,
			name: body.name,
			scopes,
			expiresAt: new Date(Date.now() + lifetime * 1000),
			createdByUserId: p.userId,
			createdVia: createdVia(c, p),
			...stored,
		});
		return c.json({ apiKey: toApiKey(k), secret }, 201);
	});

	app.openapi(rotateKey, async (c) => {
		const p = authOf(c).principal;
		const k = await teamKey(deps, p, c.req.valid("param").key);
		if (k.revokedAt !== null) throw revokedError();
		// Rotation keeps the expiry, so an expired key would stay unusable.
		if (k.expiresAt.getTime() <= Date.now()) throw expiredError();
		const { secret, ...stored } = newSecret();
		let rotated: ApiKeyRecord;
		try {
			rotated = await deps.identity.rotateApiKey(k.id, stored);
		} catch (e) {
			// Revoked since the read above.
			if (e instanceof IdentityError && e.code === "not_found") {
				throw revokedError();
			}
			throw e;
		} finally {
			deps.keyCache.forget(k.id);
		}
		return c.json({ apiKey: toApiKey(rotated), secret }, 200);
	});

	// Before `/v1/api-keys/{key}`: "self" is not a key id.
	app.openapi(revokeSelf, async (c) => {
		const p = authOf(c).principal;
		if (p.kind !== "team_key" || p.apiKeyId === undefined) {
			throw new ApiError(
				403,
				"forbidden",
				"only a team API key can revoke itself; people log out with `sbx logout`",
				{ details: { reason: "api_key_required" } },
			);
		}
		await deps.identity.revokeApiKey(p.apiKeyId, { apiKeyId: p.apiKeyId });
		deps.keyCache.forget(p.apiKeyId);
		return c.body(null, 204);
	});

	app.openapi(revokeKey, async (c) => {
		const p = authOf(c).principal;
		// keys:admin stands in for the role of a key (§7.3); a person needs
		// owner or operator rights.
		if (p.kind !== "team_key" && p.role !== "owner" && !p.isOperator) {
			throw new ApiError(
				403,
				"forbidden",
				"only an owner of the team or an operator can revoke keys",
				{ details: { reason: "role" } },
			);
		}
		const k = await teamKey(deps, p, c.req.valid("param").key);
		await deps.identity.revokeApiKey(k.id, revoker(p));
		deps.keyCache.forget(k.id);
		return c.body(null, 204);
	});
}
