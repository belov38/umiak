// Saved-snapshot tools (S11 8.6, 11.1): snapshot_save, snapshot_list,
// snapshot_delete. Creating a sandbox from a snapshot is sandbox_create with
// from_snapshot.
import type { CallToolResult } from "@modelcontextprotocol/server";
import { type OperationData, SbxError, type SnapshotData } from "@sbx/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import { ToolError } from "../errors.ts";
import { prune, toolText } from "../output/result.ts";
import { defineTool } from "../registry.ts";
import { keyFor, withUnknownOutcome } from "./keyed.ts";
import {
	type OperationView,
	operationView,
	REPLAYED_LINE,
} from "./sandbox-view.ts";
import {
	DEFAULT_WAIT_SECONDS,
	idempotencyKeyShape,
	waitShape,
} from "./shapes.ts";

const OPERATION_PATH = "/v1/operations/{operation}";
/** A wait is cut into polls of this length: after each one the client gets a progress note. */
const POLL_SECONDS = 5;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function snapshotView(
	s: SnapshotData,
	state: string = s.state,
): Record<string, unknown> {
	return {
		name: s.name,
		id: s.id,
		state,
		source_sandbox_id: s.sourceSandboxId,
		template: s.template,
		size: s.size,
		consistency: s.consistency,
		error: s.error,
		created_at: s.createdAt,
		ready_at: s.readyAt,
	};
}

function isActive(op: OperationData): boolean {
	return op.state === "pending" || op.state === "running";
}

/**
 * Long-polls `GET /v1/operations/{op}?waitSeconds=` until the operation is
 * over or `waitMs` has passed. Returns the latest data and never throws
 * because time is up.
 */
async function waitOperation(
	ctx: ToolContext,
	first: OperationData,
	waitMs: number,
	label: string,
): Promise<OperationData> {
	const started = Date.now();
	const end = started + waitMs;
	let op = first;
	while (isActive(op)) {
		const slice = Math.max(
			0,
			Math.min(POLL_SECONDS, Math.floor((end - Date.now()) / 1000)),
		);
		try {
			const r = await ctx.sbx().raw.GET(OPERATION_PATH, {
				params: { path: { operation: op.id }, query: { waitSeconds: slice } },
				...ctx.call,
			});
			op = r.data;
		} catch (err) {
			if (ctx.deadline.expired()) return op;
			throw err;
		}
		if (slice === 0 || !isActive(op)) break;
		await ctx.progress(
			Math.round((Date.now() - started) / 100) / 10,
			undefined,
			`${label} is ${op.step ?? op.state}`,
		);
	}
	return op;
}

/** The snapshot state the operation leads to; the POST answer's state while it runs. */
function stateAfter(s: SnapshotData, op: OperationData): string {
	if (op.state === "succeeded") return "ready";
	if (op.state === "failed" || op.state === "superseded") return "failed";
	return s.state;
}

export const snapshotSave = defineTool({
	name: "snapshot_save",
	title: "Save a snapshot",
	description:
		"Saves a ready or stopped sandbox as a named snapshot and waits until it is ready. A ready snapshot with the same name is REPLACED. Start a new sandbox from it with sandbox_create from_snapshot=name.",
	toolset: "snapshots",
	scopes: ["snapshots:write"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	sandboxArg: true,
	shape: {
		name: z
			.string()
			.regex(NAME_RE)
			.describe(
				"Snapshot name, [a-z0-9-], up to 63 characters, e.g. web-stack",
			),
		...waitShape(true),
		idempotency_key: idempotencyKeyShape,
	},
	async handler(args, ctx) {
		// No sandbox in the key: the same model key never saves twice (spec 7.4).
		const { modelKey, apiKey } = keyFor("snapshot_save", args.idempotency_key);
		const r = await withUnknownOutcome(ctx, modelKey, () =>
			ctx.sbx().raw.POST("/v1/snapshots", {
				body: { sandbox: args.sandbox, name: args.name },
				idempotencyKey: apiKey,
				...ctx.call,
			}),
		);
		const replayed = r.response.headers.get("Idempotency-Replayed") === "true";
		const snapshot = r.data.snapshot;
		let op = r.data.operation;
		const notes: string[] = [];
		if (args.wait ?? true) {
			try {
				op = await waitOperation(
					ctx,
					op,
					ctx.deadline.waitMs(args.wait_seconds ?? DEFAULT_WAIT_SECONDS),
					`snapshot ${snapshot.name}`,
				);
			} catch (err) {
				// Cancel, 401 and bugs go to the call wrapper.
				if (!(err instanceof SbxError) || err.status === 401) throw err;
				notes.push(
					`waiting for the snapshot failed (${err.code}): ${err.message}`,
				);
			}
		}

		const state = stateAfter(snapshot, op);
		const header: Record<string, unknown> = snapshotView(snapshot, state);
		const view: OperationView = operationView(op);
		header.operation = view;
		if (state === "failed") {
			header.error ??= op.error;
			notes.unshift(
				"the snapshot was not saved (see error); try again with a new idempotency_key (the same key returns this failure).",
			);
		} else if (state !== "ready") {
			header.operation_id = op.id;
			notes.unshift(
				`state not final yet: call snapshot_save again with this idempotency_key and wait_seconds=50, or check snapshot_list until the state is ready`,
			);
		}
		if (replayed) {
			header.replayed = true;
			notes.push(REPLAYED_LINE);
		}
		header.idempotency_key = modelKey;
		const result = toolText(header, notes.length > 0 ? [notes.join("\n")] : []);
		return state === "failed" ? { ...result, isError: true } : result;
	},
});

export const snapshotList = defineTool({
	name: "snapshot_list",
	title: "List snapshots",
	description:
		"Lists the team's saved snapshots, newest first: name, state (creating, ready, failed), source sandbox, size, template. Create a sandbox from a ready one with sandbox_create from_snapshot.",
	toolset: "snapshots",
	scopes: ["snapshots:read"],
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: false,
	shape: {
		limit: z
			.number()
			.int()
			.min(1)
			.max(MAX_LIST_LIMIT)
			.optional()
			.describe(`Page size (default ${DEFAULT_LIST_LIMIT})`),
		cursor: z
			.string()
			.min(1)
			.optional()
			.describe("next_cursor of the previous page"),
	},
	async handler(args, ctx) {
		// The API lists every snapshot in one answer, so the pages are cut here.
		const { data } = await ctx.sbx().raw.GET("/v1/snapshots", ctx.call);
		let from = 0;
		if (args.cursor !== undefined) {
			if (!/^[0-9]{1,9}$/.test(args.cursor)) {
				throw new ToolError({
					code: "validation",
					message: "cursor is not one given by snapshot_list",
					hint: "pass next_cursor of the previous page unchanged, or no cursor for the first page.",
				});
			}
			from = Number(args.cursor);
		}
		const limit = args.limit ?? DEFAULT_LIST_LIMIT;
		const page = data.data.slice(from, from + limit);
		const next = from + limit < data.data.length ? String(from + limit) : null;
		const header = {
			count: page.length,
			total: data.data.length,
			snapshots: page.map((s) => prune(snapshotView(s))),
			next_cursor: next,
		};
		const notes: string[] = [];
		if (data.data.length === 0) notes.push("no saved snapshots");
		if (next !== null) {
			notes.push(
				"more snapshots: call snapshot_list again with cursor=next_cursor",
			);
		}
		return toolText(header, notes.length > 0 ? [notes.join("\n")] : []);
	},
});

export const snapshotDelete = defineTool({
	name: "snapshot_delete",
	title: "Delete a snapshot",
	description:
		"Deletes a saved snapshot forever; sandboxes already created from it are not affected. Delete only snapshots you saved for this task. confirm must equal the snapshot name or id; a wrong one deletes nothing.",
	toolset: "snapshots",
	scopes: ["snapshots:write"],
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	sandboxArg: false,
	hiddenWhenPinned: true,
	shape: {
		name: z.string().min(1).describe("Name of the snapshot to delete"),
		confirm: z
			.string()
			.min(1)
			.regex(/^[\x20-\x7e]+$/, "must be printable ASCII")
			.describe("Name or id (snap_...) of the snapshot, equal to name"),
	},
	async handler(args, ctx): Promise<CallToolResult> {
		// Not the SDK facade: it reads the id and confirms by itself, which would
		// make `confirm` pointless.
		await ctx.sbx().raw.DELETE("/v1/snapshots/{name}", {
			params: { path: { name: args.name } },
			headers: { "Sbx-Confirm-Delete": args.confirm },
			...ctx.call,
		});
		return toolText({ name: args.name, deleted: true });
	},
});

export const SNAPSHOT_TOOLS = [snapshotSave, snapshotList, snapshotDelete];
