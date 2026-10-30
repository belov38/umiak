// Tool registry (S11 7.1-7.3, 8.8): declarative tool definitions, toolsets,
// the read-only / scope / pinned filters and the published input schema.
import type { CallToolResult } from "@modelcontextprotocol/server";
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

/** Identity helper that infers the handler's argument types from `shape`. */
export function defineTool<Shape extends z.ZodRawShape>(
	t: ToolDef<Shape>,
): ToolDef<Shape> {
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

/** The input schema the server publishes and validates for `t`. */
export function inputSchemaOf(t: ToolDef, pinned: boolean): z.ZodObject {
	return t.sandboxArg && !pinned
		? z.object({ sandbox: SANDBOX_ARG, ...t.shape })
		: z.object(t.shape);
}
