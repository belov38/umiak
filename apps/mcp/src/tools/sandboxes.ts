// Sandbox lifecycle tools (S11 8.2): create, list, get, update, stop, resume,
// fork, recover, delete.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type OperationData, type SandboxData, UmiakError } from "@umiak/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { prune, toolText } from "../output/result.ts";
import { safeLine } from "../output/sanitize.ts";
import { defineTool } from "../registry.ts";
import { keyFor, withUnknownOutcome } from "./keyed.ts";
import {
	getSandbox,
	resolveSandboxId,
	SANDBOX_PATH,
	sandboxResult,
	sandboxView,
	type WaitTarget,
	waitSandbox,
} from "./sandbox-view.ts";
import {
	DEFAULT_WAIT_SECONDS,
	envShape,
	forceStopShape,
	idempotencyKeyShape,
	idleTimeoutShape,
	labelsShape,
	MAX_SECONDS,
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

/** A fork's source operation ends before its copy starts; this only covers a slow read. */
const SOURCE_OPERATION_WAIT_SECONDS = 5;

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
			if (!(err instanceof UmiakError) || err.status === 401) throw err;
			notes.push(
				`waiting for the sandbox failed (${safeLine(err.code)}): ${safeLine(err.message)}`,
			);
		}
	}
	let sourceOperation = answer.sourceOperation;
	if (o.wait && sourceOperation?.forceStop) {
		sourceOperation = await refreshOperation(ctx, sourceOperation);
		// As snapshot_save: the copy is fine, the source did not start again.
		if (sourceOperation.forceStop?.sourceRestarted === false) {
			const e = sourceOperation.forceStop.restartError;
			notes.push(
				`the copy is made, but the source sandbox did not start again after the forced stop${e === null ? "" : ` (${safeLine(e.code)}: ${safeLine(e.message)})`}; call sandbox_resume on the source.`,
			);
		}
	}
	return sandboxResult(sandbox, {
		operation: answer.operation,
		...(sourceOperation === undefined ? {} : { sourceOperation }),
		target: o.target,
		pinned: ctx.pinned,
		...(o.replayed === undefined ? {} : { replayed: o.replayed }),
		...(o.idempotencyKey === undefined
			? {}
			: { idempotencyKey: o.idempotencyKey }),
		notes,
	});
}

/**
 * The operation's latest state (a short long-poll while it is active); the
 * old data when that fails: it only adds detail to an answer.
 */
async function refreshOperation(
	ctx: ToolContext,
	op: OperationData,
): Promise<OperationData> {
	const active = op.state === "pending" || op.state === "running";
	try {
		const r = await ctx.umiak().raw.GET("/v1/operations/{operation}", {
			params: {
				path: { operation: op.id },
				query: { waitSeconds: active ? SOURCE_OPERATION_WAIT_SECONDS : 0 },
			},
			...ctx.call,
		});
		return r.data;
	} catch (err) {
		if (!(err instanceof UmiakError) || err.status === 401) throw err;
		return op;
	}
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
		"Creates a sandbox (VM) from a template or saved snapshot and waits until it is ready. Labels it created-via=mcp. If not ready in time, call sandbox_get with wait_for=ready and wait_seconds=50.",
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
				"Template slug: linux (default), linux-desktop or windows (Windows 11 with desktop); windows-desktop is a legacy alias of windows; ignored with from_snapshot",
			),
		size: sizeShape,
		name: nameShape,
		slug: slugShape,
		labels: labelsShape,
		env: envShape,
		environment: z
			.string()
			.optional()
			.describe("Team environment name or id; default: the team's default"),
		exclude_owner_secrets: z
			.boolean()
			.optional()
			.describe("Skip your personal secrets"),
		ttl_seconds: ttlShape,
		idle_timeout_seconds: idleTimeoutShape,
		from_snapshot: z
			.string()
			.optional()
			.describe("Saved snapshot to start from"),
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
			ctx.umiak().raw.POST("/v1/sandboxes", {
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
		"Lists the team's sandboxes, newest first, one page per call; pass next_cursor as cursor for the next page. Filter by labels (created-via=mcp) to find your own.",
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
				"Comma-separated states, e.g. ready,stopped; default: all but deleted",
			),
		labels: z
			.record(z.string(), z.string())
			.optional()
			.describe("Only sandboxes with all these labels"),
		template: z
			.string()
			.optional()
			.describe(
				"Only this template slug; windows-desktop is an alias of windows",
			),
		query: z.string().optional().describe("Name or slug prefix"),
		limit: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.describe("Page size (default 50)"),
		cursor: z
			.string()
			.min(1)
			.optional()
			.describe("next_cursor of the previous page"),
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
		const { data } = await ctx.umiak().raw.GET("/v1/sandboxes", {
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
		"Shows one sandbox (state, health, labels, deadline, running operation, error, endpoints). With wait_for (ready or stopped) it first waits up to wait_seconds (default 30). State error: sandbox_recover or sandbox_delete.",
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
			.describe(`Max seconds to wait (default ${GET_WAIT_SECONDS})`),
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
		return sandboxResult(sandbox, {
			target: args.wait_for,
			pinned: ctx.pinned,
		});
	},
});

export const sandboxUpdate = defineTool({
	name: "sandbox_update",
	title: "Update a sandbox",
	description:
		"Changes name, slug, labels, ttl_seconds or idle_timeout_seconds. labels REPLACES all labels: send the full set. ttl_seconds sets the deadline to now plus the value (0 removes it).",
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
			.describe("New labels; they replace all existing ones"),
		ttl_seconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_SECONDS)
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
		const { data } = await ctx.umiak().raw.PATCH(SANDBOX_PATH, {
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
		"Stops a sandbox: processes end, the disk is kept, it stops counting against the quota. Answers at once unless wait=true. Start it again with sandbox_resume.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: { ...waitShape(false) },
	async handler(args, ctx) {
		const r = await ctx.umiak().raw.POST(`${SANDBOX_PATH}/stop`, {
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
		"Starts a stopped (or errored) sandbox again with its disk and waits until it is ready. If not ready in time, call sandbox_get with wait_for=ready and wait_seconds=50.",
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
		const r = await ctx.umiak().raw.POST(`${SANDBOX_PATH}/resume`, {
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
		"Copies a sandbox (disk, settings) to a new one, waits for ready. Overrides as in sandbox_create; env, unset_env merge onto source's.",
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
		force_stop: forceStopShape,
		ttl_seconds: ttlShape,
		idle_timeout_seconds: idleTimeoutShape,
		...waitShape(true),
		idempotency_key: idempotencyKeyShape,
	},
	async handler(args, ctx) {
		// The key is scoped by the sandbox id, so an id and a slug of the
		// same sandbox give the same API key on a retry (spec 7.4).
		const sourceId = await resolveSandboxId(ctx, args.sandbox);
		const { modelKey, apiKey } = keyFor(
			"sandbox_fork",
			args.idempotency_key,
			sourceId,
		);
		const body = compact({
			name: args.name,
			slug: args.slug,
			labels: args.labels,
			env: envPatch(args.env, args.unset_env),
			size: args.size,
			ttlSeconds: args.ttl_seconds,
			idleTimeoutSeconds: args.idle_timeout_seconds,
			forceStop: args.force_stop,
		});
		const r = await withUnknownOutcome(ctx, modelKey, () =>
			ctx.umiak().raw.POST(`${SANDBOX_PATH}/fork`, {
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
		"Reboots a stuck or errored sandbox: running processes are lost, the disk stays. Use it when agent_unavailable persists or the state is error. Waits until ready.",
	toolset: "core",
	scopes: ["sandboxes:write"],
	annotations: REPEATABLE_WRITE,
	sandboxArg: true,
	shape: { ...waitShape(true) },
	async handler(args, ctx) {
		const r = await ctx.umiak().raw.POST(`${SANDBOX_PATH}/recover`, {
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
		"Deletes a sandbox and its disk forever. Prefer sandbox_stop; delete only what you created for this task (label created-via=mcp). confirm must equal the sandbox id; a wrong one deletes nothing.",
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
			// No space: an HTTP client trims header values, so " sb_1" would
			// reach the API as "sb_1" and confirm a delete it should refuse.
			.regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces")
			.describe("Id of the sandbox to delete, equal to sandbox"),
	},
	async handler(args, ctx) {
		const { data } = await ctx.umiak().raw.DELETE(SANDBOX_PATH, {
			params: { path: { sandbox: args.sandbox } },
			headers: { "Umiak-Confirm-Delete": args.confirm },
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
