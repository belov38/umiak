// Tool registry (S11 7.1-7.3, 8.8): declarative tool definitions, toolsets,
// the read-only / scope / pinned filters and the published input schema.
import type {
	CallToolResult,
	StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import type { ServerOptions } from "./server.ts";

export type Toolset = "core" | "files" | "ports" | "snapshots" | "desktop";

/** Every toolset, in the order of spec 8.8. */
export const TOOLSETS: readonly Toolset[] = [
	"core",
	"files",
	"ports",
	"snapshots",
	"desktop",
];

/**
 * Toolsets of a comma list (`--toolsets`, `UMIAK_MCP_TOOLSETS`, `?toolsets=`):
 * spaces trimmed, repeats dropped; an unknown name is an Error listing the
 * valid ones.
 */
export function parseToolsets(csv: string): Toolset[] {
	const out: Toolset[] = [];
	for (const raw of csv.split(",")) {
		const name = raw.trim();
		if (name === "") continue;
		const t = TOOLSETS.find((v) => v === name);
		if (t === undefined) {
			throw new Error(
				`unknown toolset ${JSON.stringify(name)}; valid: ${TOOLSETS.join(", ")}`,
			);
		}
		if (!out.includes(t)) out.push(t);
	}
	if (out.length === 0) {
		throw new Error(`no toolsets given; valid: ${TOOLSETS.join(", ")}`);
	}
	return out;
}

export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
	name: string;
	title: string;
	description: string;
	toolset: Toolset;
	/** All of them are required for a team key to see the tool. */
	scopes: readonly string[];
	annotations: {
		readOnlyHint: boolean;
		destructiveHint: boolean;
		idempotentHint: boolean;
		openWorldHint: boolean;
	};
	/** The registry prepends a required `sandbox` argument unless pinned. */
	sandboxArg: boolean;
	/** Not listed in pinned mode (create, list, fork, delete). */
	hiddenWhenPinned?: boolean;
	/** Arguments without `sandbox`. */
	shape: Shape;
	/**
	 * `args.sandbox` is the sandbox of the call: the argument, or the pinned
	 * sandbox in pinned mode; an empty string for tools without `sandboxArg`.
	 */
	handler(
		args: z.infer<z.ZodObject<Shape>> & { sandbox: string },
		ctx: ToolContext,
	): Promise<CallToolResult>;
}

/** Throws on a definition the registry cannot publish. */
export function assertToolDef(t: ToolDef): void {
	if (t.sandboxArg && "sandbox" in t.shape) {
		throw new Error(
			`tool ${t.name}: sandboxArg is set, so the shape must not define its own sandbox`,
		);
	}
}

/** Identity helper that infers the handler's argument types from `shape`; checks the definition. */
export function defineTool<Shape extends z.ZodRawShape>(
	t: ToolDef<Shape>,
): ToolDef<Shape> {
	assertToolDef(t);
	return t;
}

/** The `sandbox` argument (spec 7.3), always the first property. */
export const SANDBOX_ARG = z
	.string()
	.min(1)
	.describe("Sandbox id (sb_...) or slug; prefer the id");

export function isPinned(o: Pick<ServerOptions, "pinnedSandbox">): boolean {
	return o.pinnedSandbox !== undefined;
}

/** The tools to list, in the order of `o.tools`: the intersection of all filters. */
export function selectTools(
	o: Pick<
		ServerOptions,
		"tools" | "toolsets" | "readOnly" | "principal" | "pinnedSandbox"
	>,
): ToolDef[] {
	const toolsets = o.toolsets === undefined ? undefined : new Set(o.toolsets);
	const keyScopes =
		o.principal?.kind === "team_key" ? new Set(o.principal.scopes) : undefined;
	const pinned = isPinned(o);
	return o.tools.filter(
		(t) =>
			(toolsets === undefined || toolsets.has(t.toolset)) &&
			(!o.readOnly || t.annotations.readOnlyHint) &&
			(keyScopes === undefined || t.scopes.every((s) => keyScopes.has(s))) &&
			!(pinned && t.hiddenWhenPinned),
	);
}

/** The input schema the server validates for `t`. */
export function inputSchemaOf(t: ToolDef, pinned: boolean): z.ZodObject {
	return t.sandboxArg && !pinned
		? z.object({ sandbox: SANDBOX_ARG, ...t.shape })
		: z.object(t.shape);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * zod emits `propertyNames: {type: "string"}` for every record; some clients
 * do not know the keyword and it says nothing for string keys, so it is not
 * published (spec 7.2 dictionaries are `{type: object, additionalProperties}`).
 */
export function stripPropertyNames(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(stripPropertyNames);
	if (!isPlainObject(node)) return node;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node)) {
		if (k === "propertyNames") continue;
		// Under `properties` the keys are argument names, not keywords.
		out[k] =
			k === "properties" && isPlainObject(v)
				? Object.fromEntries(
						Object.entries(v).map(([n, c]) => [n, stripPropertyNames(c)]),
					)
				: stripPropertyNames(v);
	}
	return out;
}

/**
 * What `registerTool` gets: validation by the zod schema of `inputSchemaOf`,
 * JSON Schema of it without `propertyNames`.
 */
export function publishedSchemaOf(
	t: ToolDef,
	pinned: boolean,
): StandardSchemaWithJSON<Record<string, unknown>> {
	const std = inputSchemaOf(t, pinned)["~standard"];
	return {
		"~standard": {
			version: 1,
			vendor: "umiak",
			validate: (value) => std.validate(value),
			jsonSchema: {
				input: (opts) =>
					stripPropertyNames(std.jsonSchema.input(opts)) as Record<
						string,
						unknown
					>,
				output: (opts) => std.jsonSchema.output(opts),
			},
		},
	};
}

/** The JSON Schema `tools/list` publishes for `t` (draft 2020-12, as the SDK converts it). */
export function publishedJsonSchemaOf(
	t: ToolDef,
	pinned: boolean,
): Record<string, unknown> {
	return publishedSchemaOf(t, pinned)["~standard"].jsonSchema.input({
		target: "draft-2020-12",
	});
}
