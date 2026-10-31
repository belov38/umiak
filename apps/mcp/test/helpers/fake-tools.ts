// Four fake tools for the registry and server tests: one read-only, one
// destructive, one hidden when pinned, one that needs `files:write`.

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "../../src/context.ts";
import { toolText } from "../../src/output/result.ts";
import { defineTool, type ToolDef } from "../../src/registry.ts";

export interface FakeCall {
	tool: string;
	args: Record<string, unknown>;
	ctx: ToolContext;
}

/** What a fake tool does when called; the default echoes its arguments. */
export type Behaviour = (call: FakeCall) => Promise<CallToolResult>;

export interface FakeTools {
	tools: ToolDef[];
	calls: FakeCall[];
	/** Replace to make the next calls fail, wait, report progress... */
	behaviour: Behaviour;
}

const echo: Behaviour = async ({ tool, args }) => toolText({ tool, args });

export function fakeTools(): FakeTools {
	const state: FakeTools = { tools: [], calls: [], behaviour: echo };
	const run = (tool: string) => (args: object, ctx: ToolContext) => {
		const call = { tool, args: { ...args }, ctx };
		state.calls.push(call);
		return state.behaviour(call);
	};
	state.tools = [
		defineTool({
			name: "fake_get",
			title: "Get thing",
			description: "Reads a thing in a sandbox.",
			toolset: "core",
			scopes: ["sandboxes:read"],
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			sandboxArg: true,
			shape: {
				path: z.string().min(1).describe("Path of the thing"),
				wait_seconds: z
					.number()
					.int()
					.min(0)
					.max(50)
					.optional()
					.describe("How long to wait"),
			},
			handler: run("fake_get"),
		}),
		defineTool({
			name: "fake_delete",
			title: "Delete thing",
			description: "Deletes a saved thing.",
			toolset: "snapshots",
			scopes: ["snapshots:write"],
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
			sandboxArg: true,
			shape: { confirm: z.string().describe("Id of the thing to delete") },
			handler: run("fake_delete"),
		}),
		defineTool({
			name: "fake_create",
			title: "Create sandbox",
			description: "Creates a sandbox.",
			toolset: "core",
			scopes: ["sandboxes:write"],
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			sandboxArg: false,
			hiddenWhenPinned: true,
			shape: { template: z.string().describe("Template name") },
			handler: run("fake_create"),
		}),
		defineTool({
			name: "fake_write",
			title: "Write file",
			description: "Writes a file in a sandbox.",
			toolset: "files",
			scopes: ["files:write"],
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
			sandboxArg: true,
			shape: {
				path: z.string().describe("File path"),
				content: z.string().describe("File content"),
			},
			handler: run("fake_write"),
		}),
	];
	return state;
}
