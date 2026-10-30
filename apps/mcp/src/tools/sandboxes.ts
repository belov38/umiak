// Sandbox lifecycle tools (S11 8.2): create, list, get, update, stop, resume,
// fork, recover, delete.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type OperationData, type SandboxData, SbxError } from "@sbx/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { prune, toolText } from "../output/result.ts";
import { defineTool } from "../registry.ts";
import { keyFor, withUnknownOutcome } from "./keyed.ts";
import {
	getSandbox,
	SANDBOX_PATH,
	sandboxResult,
	sandboxView,
	type WaitTarget,
	waitSandbox,
} from "./sandbox-view.ts";
import {
	DEFAULT_WAIT_SECONDS,
	envShape,
	idempotencyKeyShape,
	idleTimeoutShape,
	labelsShape,
	MAX_WAIT_SECONDS,
	nameShape,
	sizeShape,
	slugShape,
	ttlShape,
	unsetEnvShape,
	waitShape,
} from "./shapes.ts";
import { compact } from "./view.ts";

/** `get` waits this long when `wait_for` is given and `wait_seconds` is not. */
const GET_WAIT_SECONDS = 30;

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const REPEATABLE_WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const NEW_RESOURCE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
} as const;

interface ActionAnswer {
	sandbox: SandboxData;
	operation: OperationData;
	sourceOperation?: OperationData;
}

interface FinishOptions {
	target: WaitTarget;
	wait: boolean;
	waitSeconds: number;
	replayed?: boolean;
	idempotencyKey?: string;
}

/**
 * Waits (when asked) for the state the action leads to and builds the answer.
 * A failed poll does not lose the sandbox the action already made: the answer
 * says the wait failed and the model continues with sandbox_get.
 */
async function finishAction(
	ctx: ToolContext,
	answer: ActionAnswer,
	o: FinishOptions,
): Promise<CallToolResult> {
	let sandbox = answer.sandbox;
	const notes: string[] = [];
	if (o.wait) {
		try {
			sandbox = await waitSandbox(
				ctx,
				sandbox.id,
				o.target,
				ctx.deadline.waitMs(o.waitSeconds),
				sandbox,
			);
		} catch (err) {
			// Cancel, 401 and bugs go to the call wrapper.
			if (!(err instanceof SbxError) || err.status === 401) throw err;
			notes.push(
				`waiting for the sandbox failed (${err.code}): ${err.message}`,
			);
		}
	}
	return sandboxResult(sandbox, {
		operation: answer.operation,
		...(answer.sourceOperation === undefined
			? {}
			: { sourceOperation: answer.sourceOperation }),
		target: o.target,
		...(o.replayed === undefined ? {} : { replayed: o.replayed }),
		...(o.idempotencyKey === undefined
			? {}
			: { idempotencyKey: o.idempotencyKey }),
		notes,
	});
}

/** `{K: v}` and a list of names to remove -> the API's `{K: v | null}`. */
function envPatch(
	env: Record<string, string> | undefined,
	unset: string[] | undefined,
): Record<string, string | null> | undefined {
	if (env === undefined && unset === undefined) return undefined;
	const patch: Record<string, string | null> = { ...env };
	for (const name of unset ?? []) {
		if (env !== undefined && name in env) {
			throw new ToolError({
				code: "validation",
				message: `${name} is both in env and in unset_env`,
				hint: "give each variable either a value in env or a place in unset_env, not both.",
			});
		}
		patch[name] = null;
	}
	return patch;
}

export const sandboxCreate = defineTool({
	name: "sandbox_create",
	title: "Create a sandbox",
	description:
		"Creates a sandbox (a VM) from a template or a saved snapshot and by default waits until it is ready (up to wait_seconds, default 45). Pick template and size with templates_list; limits_get shows the quota. The sandbox gets the label created-via=mcp. If it is not ready in time the answer has state creating and operation_id: call sandbox_get with wait_for=ready and wait_seconds=50. env takes non-secret values only. Pass idempotency_key (a new UUID per new sandbox) to make a repeat after a timeout safe; the answer always shows the key used. Scope sandboxes:write (snapshots:read for from_snapshot, environments:read for environment).",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: NEW_RESOURCE,
	sandboxArg: false,
	hiddenWhenPinned: true,
	shape: {
		template: z
			.string()
			.optional()
			.describe(
				"Template slug from templates_list (default linux); ignored with from_snapshot",
			),
		size: sizeShape,
		name: nameShape,
		slug: slugShape,
		labels: labelsShape,
		env: envShape,
		environment: z
			.string()
			.optional()
			.describe(
				"Team environment (name or env_... id) to apply; default: the team's default",
			),
		exclude_owner_secrets: z
			.boolean()
			.optional()
			.describe("Do not pass your personal secrets into the sandbox"),
		ttl_seconds: ttlShape,
		idle_timeout_seconds: idleTimeoutShape,
		from_snapshot: z
			.string()
			.optional()
			.describe("Name of a saved snapshot to start from (snapshot_list)"),
		...waitShape(true),
		idempotency_key: idempotencyKeyShape,
	},
	async handler(args, ctx) {
		// The API always gets the derived key, so a generated key works for a
		// repeat too: the model gets it back in the answer.
		const { modelKey, apiKey } = keyFor("sandbox_create", args.idempotency_key);
		const body = compact({
			template: args.template,
			size: args.size,
			name: args.name,
			slug: args.slug,
			labels: { "created-via": "mcp", ...args.labels },
			env: args.env,
			environment: args.environment,
			excludeOwnerSecrets: args.exclude_owner_secrets,
			ttlSeconds: args.ttl_seconds,
			idleTimeoutSeconds: args.idle_timeout_seconds,
			from:
				args.from_snapshot === undefined
					? undefined
					: { snapshot: args.from_snapshot },
		});
		const r = await withUnknownOutcome(ctx, modelKey, () =>
			ctx.sbx().raw.POST("/v1/sandboxes", {
				body,
				idempotencyKey: apiKey,
				...ctx.call,
			}),
		);
		return finishAction(ctx, r.data, {
			target: "ready",
			wait: args.wait ?? true,
			waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
			replayed: r.response.headers.get("Idempotency-Replayed") === "true",
			idempotencyKey: modelKey,
		});
	},
});

export const sandboxList = defineTool({
	name: "sandbox_list",
	title: "List sandboxes",
	description:
		"Lists the sandboxes of the team, newest first, one page per call. Filters: state (comma-separated, for example ready,stopped; deleted ones only when asked), labels (all must match), template, query (prefix of name or slug). limit is 1-200, default 50. When the answer has next_cursor, pass it as cursor to get the next page. Use it to find your own sandboxes (label created-via=mcp) before creating more or deleting.",
	toolset: "core",
	scopes: ["sandboxes:read"],
	annotations: READ_ONLY,
	sandboxArg: false,
	hiddenWhenPinned: true,
	shape: {
		state: z
			.string()
			.optional()
			.describe(
				"Comma-separated states, for example ready,stopped. Default: all but deleted",
			),
		labels: z
			.record(z.string(), z.string())
			.optional()
			.describe("Only sandboxes with all these labels, key -> value"),
		template: z.string().optional().describe("Only this template slug"),
		query: z
			.string()
			.optional()
			.describe("Prefix of the name or slug, case-insensitive"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.describe("Page size, 1-200 (default 50)"),
		cursor: z
			.string()
			.min(1)
			.optional()
			.describe("next_cursor of the previous page, unchanged"),
	},
	async handler(args, ctx) {
		const label = Object.entries(args.labels ?? {}).map(
			([k, v]) => `${k}=${v}`,
		);
		const query = compact({
			state: args.state,
			label: label.length === 0 ? undefined : label,
			template: args.template,
			q: args.query,
			limit: args.limit ?? 50,
			cursor: args.cursor,
		});
		const { data } = await ctx.sbx().raw.GET("/v1/sandboxes", {
			params: { query },
			...ctx.call,
		});
		const header = {
			count: data.data.length,
			sandboxes: data.data.map((s) => prune(sandboxView(s))),
			next_cursor: data.nextCursor,
		};
		const notes: string[] = [];
		if (data.data.length === 0) notes.push("no sandbox matches the filters");
		if (data.nextCursor !== null) {
			notes.push(
				"more sandboxes: call sandbox_list again with cursor=next_cursor",
			);
		}
		return toolText(header, notes.length > 0 ? [notes.join("\n")] : []);
	},
});

export const sandboxGet = defineTool({
	name: "sandbox_get",
	title: "Get a sandbox",
	description:
		"Shows one sandbox: state (creating, ready, stopping, stopped, starting, error, deleting), health, activity, template, size, labels, deadline, running operation, error and endpoints (port URL template, ssh, desktop). With wait_for=ready or stopped it first waits up to wait_seconds (default 30, max 50) for that state: use it after an answer that says state not final yet. A sandbox in state error: sandbox_recover or sandbox_delete.",
	toolset: "core",
	scopes: ["sandboxes:read"],
	annotations: READ_ONLY,
	sandboxArg: true,
	shape: {
		wait_for: z
			.enum(["ready", "stopped"])
			.optional()
			.describe("Wait for this state before answering"),
		wait_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe(
				`How long to wait for wait_for, 0-${MAX_WAIT_SECONDS} seconds (default ${GET_WAIT_SECONDS})`,
			),
	},
	async handler(args, ctx) {
		if (args.wait_for === undefined) {
			return sandboxResult(await getSandbox(ctx, args.sandbox));
		}
		const sandbox = await waitSandbox(
			ctx,
			args.sandbox,
			args.wait_for,
			ctx.deadline.waitMs(args.wait_seconds ?? GET_WAIT_SECONDS),
		);
		return sandboxResult(sandbox, { target: args.wait_for });
	},
});

export const sandboxUpdate = defineTool({
	name: "sandbox_update",
	title: "Update a sandbox",
	description:
		"Changes the name, slug, labels, ttl_seconds or idle_timeout_seconds of a sandbox without restarting it. labels REPLACES all labels: send the full set. ttl_seconds sets the deadline to now plus the value (this also extends a sandbox that is about to expire); 0 removes the TTL. A new slug changes the port URLs at once. Give at least one field.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: {
		name: nameShape,
		slug: slugShape,
		labels: z
			.record(z.string(), z.string())
			.optional()
			.describe("The new labels, key -> value; they replace all existing ones"),
		ttl_seconds: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("New lifetime in seconds from now; 0 removes the limit"),
		idle_timeout_seconds: idleTimeoutShape,
	},
	async handler(args, ctx) {
		const body = compact({
			name: args.name,
			slug: args.slug,
			labels: args.labels,
			ttlSeconds:
				args.ttl_seconds === undefined
					? undefined
					: args.ttl_seconds === 0
						? null
						: args.ttl_seconds,
			idleTimeoutSeconds: args.idle_timeout_seconds,
		});
		if (Object.keys(body).length === 0) {
			throw new ToolError({
				code: "validation",
				message: "nothing to change",
				hint: "give at least one of name, slug, labels, ttl_seconds, idle_timeout_seconds.",
			});
		}
		const { data } = await ctx.sbx().raw.PATCH(SANDBOX_PATH, {
			params: { path: { sandbox: args.sandbox } },
			body,
			...ctx.call,
		});
		return sandboxResult(data);
	},
});

export const sandboxStop = defineTool({
	name: "sandbox_stop",
	title: "Stop a sandbox",
	description:
		"Stops a running sandbox: its processes end, the disk is kept and it stops counting against the quota. Safe to repeat. Prefer it to sandbox_delete. By default it answers at once with the stop operation; wait=true waits for state stopped (up to wait_seconds). Start the sandbox again with sandbox_resume.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: { ...waitShape(false) },
	async handler(args, ctx) {
		const r = await ctx.sbx().raw.POST(`${SANDBOX_PATH}/stop`, {
			params: { path: { sandbox: args.sandbox } },
			...ctx.call,
		});
		return finishAction(ctx, r.data, {
			target: "stopped",
			wait: args.wait ?? false,
			waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
		});
	},
});

export const sandboxResume = defineTool({
	name: "sandbox_resume",
	title: "Resume a sandbox",
	description:
		"Starts a stopped sandbox (or one in state error) again with its disk and by default waits until it is ready (up to wait_seconds, default 45). env sets variables (non-secret values only) and unset_env removes names; size and ttl_seconds are stored with the sandbox. Safe to repeat. If it is not ready in time, call sandbox_get with wait_for=ready and wait_seconds=50.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: {
		env: envShape,
		unset_env: unsetEnvShape,
		size: z.string().optional().describe("Another size slug (templates_list)"),
		ttl_seconds: ttlShape,
		...waitShape(true),
	},
	async handler(args, ctx) {
		const r = await ctx.sbx().raw.POST(`${SANDBOX_PATH}/resume`, {
			params: { path: { sandbox: args.sandbox } },
			body: compact({
				env: envPatch(args.env, args.unset_env),
				size: args.size,
				ttlSeconds: args.ttl_seconds,
			}),
			...ctx.call,
		});
		return finishAction(ctx, r.data, {
			target: "ready",
			wait: args.wait ?? true,
			waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
		});
	},
});

export const sandboxFork = defineTool({
	name: "sandbox_fork",
	title: "Fork a sandbox",
	description:
		"Copies a ready or stopped sandbox (disk and settings) into a new sandbox; the source keeps running. Overrides: name, slug, labels (default: the source's), env and unset_env (merged onto the source's; non-secret values only), size, ttl_seconds, idle_timeout_seconds. By default waits until the copy is ready (up to wait_seconds, default 45). The answer is the new sandbox with operation (its create) and source_operation. Pass idempotency_key (a new value per fork) so a repeat after a timeout does not fork twice.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: NEW_RESOURCE,
	sandboxArg: true,
	hiddenWhenPinned: true,
	shape: {
		name: nameShape,
		slug: slugShape,
		labels: labelsShape,
		env: envShape,
		unset_env: unsetEnvShape,
		size: sizeShape,
		ttl_seconds: ttlShape,
		idle_timeout_seconds: idleTimeoutShape,
		...waitShape(true),
		idempotency_key: idempotencyKeyShape,
	},
	async handler(args, ctx) {
		const { modelKey, apiKey } = keyFor(
			"sandbox_fork",
			args.idempotency_key,
			args.sandbox,
		);
		const body = compact({
			name: args.name,
			slug: args.slug,
			labels: args.labels,
			env: envPatch(args.env, args.unset_env),
			size: args.size,
			ttlSeconds: args.ttl_seconds,
			idleTimeoutSeconds: args.idle_timeout_seconds,
		});
		const r = await withUnknownOutcome(ctx, modelKey, () =>
			ctx.sbx().raw.POST(`${SANDBOX_PATH}/fork`, {
				params: { path: { sandbox: args.sandbox } },
				body,
				idempotencyKey: apiKey,
				...ctx.call,
			}),
		);
		return finishAction(ctx, r.data, {
			target: "ready",
			wait: args.wait ?? true,
			waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
			replayed: r.response.headers.get("Idempotency-Replayed") === "true",
			idempotencyKey: modelKey,
		});
	},
});

export const sandboxRecover = defineTool({
	name: "sandbox_recover",
	title: "Recover a sandbox",
	description:
		"Reboots a sandbox that is stuck or in state error: running processes are lost, the disk stays. Use it when commands keep failing with agent_unavailable or the state is error. By default waits until the sandbox is ready (up to wait_seconds, default 45). Safe to repeat.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: { ...waitShape(true) },
	async handler(args, ctx) {
		const r = await ctx.sbx().raw.POST(`${SANDBOX_PATH}/recover`, {
			params: { path: { sandbox: args.sandbox } },
			...ctx.call,
		});
		return finishAction(ctx, r.data, {
			target: "ready",
			wait: args.wait ?? true,
			waitSeconds: args.wait_seconds ?? DEFAULT_WAIT_SECONDS,
		});
	},
});

export const sandboxDelete = defineTool({
	name: "sandbox_delete",
	title: "Delete a sandbox",
	description:
		"Deletes a sandbox and its disk forever. Prefer sandbox_stop. Delete only sandboxes you created for this task (label created-via=mcp). confirm is required: pass the same sandbox id as in sandbox. A wrong confirm deletes nothing (confirmation_required). Scope sandboxes:delete.",
	toolset: "core",
	scopes: ["sandboxes:delete"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: true,
	hiddenWhenPinned: true,
	shape: {
		confirm: z
			.string()
			.min(1)
			.regex(/^[\x20-\x7e]+$/, "must be printable ASCII")
			.describe("The id (sb_...) of the sandbox you delete, equal to sandbox"),
	},
	async handler(args, ctx) {
		const { data } = await ctx.sbx().raw.DELETE(SANDBOX_PATH, {
			params: { path: { sandbox: args.sandbox } },
			headers: { "Sbx-Confirm-Delete": args.confirm },
			...ctx.call,
		});
		return sandboxResult(data.sandbox, {
			operation: data.operation,
			notes: [
				data.operation === null
					? "the sandbox was already deleted"
					: "the sandbox is being deleted; its disk is removed",
			],
		});
	},
});

export const SANDBOX_TOOLS = [
	sandboxCreate,
	sandboxList,
	sandboxGet,
	sandboxUpdate,
	sandboxStop,
	sandboxResume,
	sandboxFork,
	sandboxRecover,
	sandboxDelete,
];
