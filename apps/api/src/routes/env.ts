// Env and secrets of a sandbox (S7 §8.3, S8 C2): GET, PUT (replace sets)
// and PATCH (merge by key). After a write the new sets go to the running
// agent when the sandbox is ready; an unreachable agent is not an error
// (`delivered: false`, S6 applies them at the next resume or reprovision).
// Secret values are never returned and never logged.
import { randomUUID } from "node:crypto";
import { createRoute } from "@hono/zod-openapi";
import { AgentUnavailableError } from "@umiak/agent-client";
import {
	type EnvReplaceInput,
	type Sandbox,
	SECRET_FILE_DEFAULT_MODE,
	type SecretPatch,
	type SecretSets,
} from "@umiak/core";
import type { Context } from "hono";
import type { AgentSecrets } from "../agent/types.ts";
import { authOf } from "../auth/principal.ts";
import { requireScope } from "../auth/scopes.ts";
import type { ApiApp, ApiDeps, ApiEnv } from "../deps.ts";
import { resolveSandboxRef } from "../map/sandbox.ts";
import {
	ERROR_RESPONSES,
	errorResponse,
	jsonBody,
	jsonResponse,
} from "../openapi/registry.ts";
import { compact, SandboxParams } from "../schemas/common.ts";
import {
	EnvPatchRequest,
	EnvReplaceRequest,
	SandboxEnvSchema,
	SandboxEnvUpdateSchema,
} from "../schemas/env.ts";

const TAGS = ["sandboxes"];

const notFound404 = errorResponse("`not_found`: no such sandbox in the team");

const getEnv = createRoute({
	method: "get",
	path: "/v1/sandboxes/{sandbox}/env",
	operationId: "sandboxes.getEnv",
	summary: "Get env and secret names",
	description:
		"The sandbox's env variables with values, the names of its secret variables and the " +
		"metadata of its secret files. Secret values are never returned.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:read")] as const,
	request: { params: SandboxParams },
	responses: {
		200: jsonResponse(SandboxEnvSchema, "Env and secret names"),
		404: notFound404,
		...ERROR_RESPONSES,
	},
});

const writeResponses = {
	200: jsonResponse(SandboxEnvUpdateSchema, "The stored sets and delivery"),
	400: errorResponse(
		"`validation`: a name, a value or a limit of the env sets (checked on the result)",
	),
	404: notFound404,
	409: errorResponse("`invalid_state`: deleting or deleted"),
	...ERROR_RESPONSES,
};

const replaceEnv = createRoute({
	method: "put",
	path: "/v1/sandboxes/{sandbox}/env",
	operationId: "sandboxes.replaceEnv",
	summary: "Replace env and secrets",
	description:
		"Each given set (env, secrets, secretFiles) replaces that set whole; the others stay. " +
		"New commands see the new values, running ones do not. `delivered: false` means the " +
		"sandbox is not ready or its agent is unreachable: the sets apply at the next resume.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		body: jsonBody(EnvReplaceRequest, "Sets to replace"),
	},
	responses: writeResponses,
});

const patchEnv = createRoute({
	method: "patch",
	path: "/v1/sandboxes/{sandbox}/env",
	operationId: "sandboxes.patchEnv",
	summary: "Change env and secrets by key",
	description:
		"Merges by key: a value sets the variable, null deletes it; secret files by name (a " +
		"file replaces the one with its name, null deletes it). Answers like PUT.",
	tags: TAGS,
	middleware: [requireScope("sandboxes:write")] as const,
	request: {
		params: SandboxParams,
		body: jsonBody(EnvPatchRequest, "Changes by key"),
	},
	responses: writeResponses,
});

function base64Size(b64: string): number {
	return Buffer.from(b64, "base64").length;
}

/** The public view of the sets: env values, secret names, file metadata. */
export function envView(sets: SecretSets) {
	return {
		env: sets.env,
		secretKeys: Object.keys(sets.secrets).sort(),
		secretFiles: sets.secretFiles.map((f) => ({
			name: f.name,
			mode: f.mode ?? SECRET_FILE_DEFAULT_MODE,
			linkPath: f.linkPath ?? null,
			sizeBytes: base64Size(f.contentBase64),
		})),
	};
}

function agentSecrets(sets: SecretSets): AgentSecrets {
	return {
		secretEnv: sets.secrets,
		secretFiles: sets.secretFiles.map((f) => ({
			name: f.name,
			content: Buffer.from(f.contentBase64, "base64"),
			mode: f.mode ?? SECRET_FILE_DEFAULT_MODE,
			linkPath: f.linkPath ?? "",
		})),
	};
}

/**
 * Sends the changed sets to the agent of a ready sandbox. False when the
 * sandbox is not ready or a call failed; the stored sets stay either way.
 */
async function deliver(
	deps: ApiDeps,
	c: Context<ApiEnv>,
	s: Sandbox,
	sets: SecretSets,
	changed: { env: boolean; secrets: boolean },
): Promise<boolean> {
	if (s.state !== "ready" || s.machineId === null) return false;
	try {
		// Each mutating agent call gets its own request id (S7 §5.7).
		if (changed.env) {
			await deps.agent.updateEnv(
				s.machineId,
				{ UMIAK_API_URL: deps.settings.apiUrl, ...sets.env },
				randomUUID(),
			);
		}
		if (changed.secrets) {
			// A lost response may still have written files. Record uncertainty
			// before the RPC and keep it until an empty delivery is confirmed.
			const tracked = await deps.pool?.query<{ secrets_generation: number }>(
				`UPDATE runtime.machines m SET secrets_generation = secrets_generation + 1,
				 secret_files_on_disk = secret_files_on_disk OR ($2 AND EXISTS (
				 SELECT 1 FROM runtime.template_builds b WHERE b.id = m.template_build_id AND b.os = 'windows')),
				 version = version + 1 WHERE m.id = $1 RETURNING secrets_generation`,
				[s.machineId, sets.secretFiles.length > 0],
			);
			const generation = tracked?.rows[0]?.secrets_generation;
			await deps.agent.updateSecrets(
				s.machineId,
				agentSecrets(sets),
				randomUUID(),
			);
			if (generation !== undefined) {
				await deps.pool?.query(
					`UPDATE runtime.machines SET provisioned_secrets_generation = $2,
					 secret_files_on_disk = CASE WHEN secrets_generation = $2 AND NOT $3 THEN false ELSE secret_files_on_disk END,
					 version = version + 1 WHERE id = $1`,
					[s.machineId, generation, sets.secretFiles.length > 0],
				);
			}
		}
		return true;
	} catch (e) {
		if (!(e instanceof AgentUnavailableError)) {
			// Never the error text: it could echo a value.
			deps.log.warn(
				{
					requestId: c.var.requestId,
					sandboxId: s.id,
					err: e instanceof Error ? e.name : typeof e,
					code: (e as { code?: unknown } | null)?.code,
				},
				"env delivery to the agent failed",
			);
		}
		return false;
	}
}

export function registerEnvRoutes(app: ApiApp, deps: ApiDeps): void {
	app.openapi(getEnv, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		return c.json(envView(await deps.svc.getEnv(p, ref)), 200);
	});

	app.openapi(replaceEnv, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const body = compact(c.req.valid("json")) as EnvReplaceInput;
		const r = await deps.svc.replaceEnv(p, ref, body);
		const delivered = await deliver(deps, c, r.sandbox, r.sets, {
			env: body.env !== undefined,
			secrets: body.secrets !== undefined || body.secretFiles !== undefined,
		});
		return c.json({ delivered, ...envView(r.sets) }, 200);
	});

	app.openapi(patchEnv, async (c) => {
		const p = authOf(c).principal;
		const ref = resolveSandboxRef(c.req.valid("param").sandbox);
		const body = compact(c.req.valid("json")) as SecretPatch;
		const r = await deps.svc.patchEnv(p, ref, body);
		const delivered = await deliver(deps, c, r.sandbox, r.sets, {
			env: body.env !== undefined,
			secrets: body.secrets !== undefined || body.secretFiles !== undefined,
		});
		return c.json({ delivered, ...envView(r.sets) }, 200);
	});
}
