// SSH keys of a person (S7 §11.3): for logins with plain `ssh` through the
// gateway. Person only (team keys use certificates); the fingerprint is
// unique across the platform, so the gateway finds the user by it.
import { createRoute } from "@hono/zod-openapi";
import {
	decodeUuid,
	encodeUuid,
	IdentityError,
	type SshKeyRecord,
} from "@sbx/auth";
import { authOf } from "../auth/principal.ts";
import { requireHuman, requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps } from "../deps.ts";
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
	CreateSshKeyRequest,
	SshKeyListSchema,
	SshKeyParams,
	SshKeySchema,
} from "../schemas/ssh.ts";
import { parsePublicKeyField } from "./ssh.ts";

const TAGS = ["ssh"];

const human403 = errorResponse(
	"`forbidden` with details.reason `user_required`: a team API key has no SSH keys",
);

const listSshKeys = createRoute({
	method: "get",
	path: "/v1/ssh-keys",
	operationId: "sshKeys.list",
	summary: "List my SSH keys",
	description:
		"SSH public keys of the calling person, oldest first. Only a person (browser session " +
		"or `sbx login`).",
	tags: TAGS,
	security: HUMAN_ONLY,
	middleware: [requireScope("ssh:connect"), requireHuman()] as const,
	responses: {
		200: jsonResponse(SshKeyListSchema, "My SSH keys"),
		403: human403,
		...ERROR_RESPONSES,
	},
});

const addSshKey = createRoute({
	method: "post",
	path: "/v1/ssh-keys",
	operationId: "sshKeys.create",
	summary: "Add an SSH key",
	description:
		"Registers a public key of the calling person for `ssh <sandbox>@<ssh host>`. Types: " +
		"ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa of at least 3072 bits; no " +
		"certificates. A key can belong to one person on the platform only.",
	tags: TAGS,
	security: HUMAN_ONLY,
	middleware: [requireScope("ssh:connect"), requireHuman()] as const,
	request: { body: jsonBody(CreateSshKeyRequest, "Name and public key") },
	responses: {
		201: jsonResponse(SshKeySchema, "Added"),
		400: errorResponse("`validation`: not a supported public key, or the name"),
		403: human403,
		409: errorResponse(
			"`ssh_key_in_use`: this key (fingerprint) is already registered",
		),
		...ERROR_RESPONSES,
	},
});

const removeSshKey = createRoute({
	method: "delete",
	path: "/v1/ssh-keys/{key}",
	operationId: "sshKeys.delete",
	summary: "Remove an SSH key",
	description:
		"The key stops working for new logins at once; open sessions stay.",
	tags: TAGS,
	security: HUMAN_ONLY,
	middleware: [requireScope("ssh:connect"), requireHuman()] as const,
	request: { params: SshKeyParams },
	responses: {
		204: { description: "Removed" },
		403: human403,
		404: errorResponse("`not_found`: no such key of mine"),
		...ERROR_RESPONSES,
	},
});

function toSshKey(k: SshKeyRecord) {
	return {
		id: encodeUuid("sshKey", k.id),
		name: k.name,
		fingerprint: k.fingerprint,
		type: k.type as (typeof SshKeySchema._output)["type"],
		createdAt: iso(k.createdAt),
		lastUsedAt: isoOrNull(k.lastUsedAt),
	};
}

/** The person of a `requireHuman` route. */
function userIdOf(c: Parameters<typeof authOf>[0]): string {
	return authOf(c).principal.userId as string;
}

export function registerSshKeyRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(listSshKeys, async (c) => {
		const keys = await deps.identity.listSshKeys(userIdOf(c));
		return c.json({ data: keys.map(toSshKey) }, 200);
	});

	app.openapi(addSshKey, async (c) => {
		const userId = userIdOf(c);
		const { name, publicKey } = c.req.valid("json");
		const k = parsePublicKeyField(publicKey);
		try {
			const r = await deps.identity.addSshKey({
				userId,
				name,
				// Stored without the comment: the name is shown instead.
				publicKey: `${k.type} ${k.blob.toString("base64")}`,
				fingerprint: k.fingerprint,
				type: k.type,
			});
			return c.json(toSshKey(r), 201);
		} catch (e) {
			if (e instanceof IdentityError && e.code === "fingerprint_taken") {
				throw new ApiError(
					409,
					"ssh_key_in_use",
					`the key ${k.fingerprint} is already registered on the platform; use another key`,
				);
			}
			throw e;
		}
	});

	app.openapi(removeSshKey, async (c) => {
		const id = decodeUuid("sshKey", c.req.valid("param").key);
		if (id === null) throw notFoundError("ssh key");
		try {
			await deps.identity.removeSshKey(userIdOf(c), id);
		} catch (e) {
			if (e instanceof IdentityError && e.code === "not_found") {
				throw notFoundError("ssh key");
			}
			throw e;
		}
		return c.body(null, 204);
	});
}
