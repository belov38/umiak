import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	pinnedInstructions,
	SERVER_INSTRUCTIONS,
} from "../src/instructions.ts";
import {
	defineTool,
	inputSchemaOf,
	parseToolsets,
	publishedJsonSchemaOf,
	selectTools,
	stripPropertyNames,
	TOOLSETS,
} from "../src/registry.ts";
import { fakeTools } from "./helpers/fake-tools.ts";

const { tools } = fakeTools();
const names = (list: { name: string }[]) => list.map((t) => t.name);

describe("selectTools", () => {
	it("keeps every tool in order by default", () => {
		expect(names(selectTools({ tools }))).toEqual([
			"fake_get",
			"fake_delete",
			"fake_create",
			"fake_write",
		]);
	});

	it("filters by toolsets", () => {
		expect(names(selectTools({ tools, toolsets: ["core"] }))).toEqual([
			"fake_get",
			"fake_create",
		]);
		expect(
			names(selectTools({ tools, toolsets: ["files", "snapshots"] })),
		).toEqual(["fake_delete", "fake_write"]);
		expect(names(selectTools({ tools, toolsets: [...TOOLSETS] }))).toHaveLength(
			4,
		);
		expect(selectTools({ tools, toolsets: ["desktop"] })).toEqual([]);
	});

	it("read-only keeps only tools with readOnlyHint", () => {
		expect(names(selectTools({ tools, readOnly: true }))).toEqual(["fake_get"]);
		expect(
			names(selectTools({ tools, readOnly: true, toolsets: ["files"] })),
		).toEqual([]);
	});

	it("a team key sees only tools all of whose scopes it has", () => {
		const principal = {
			kind: "team_key" as const,
			scopes: ["sandboxes:read", "sandboxes:write", "snapshots:write"],
		};
		expect(names(selectTools({ tools, principal }))).toEqual([
			"fake_get",
			"fake_delete",
			"fake_create",
		]);
		expect(
			names(
				selectTools({
					tools,
					principal: { kind: "team_key", scopes: ["files:write"] },
				}),
			),
		).toEqual(["fake_write"]);
		expect(
			selectTools({ tools, principal: { kind: "team_key", scopes: [] } }),
		).toEqual([]);
	});

	it("a person (oidc, session) or an unknown principal sees everything", () => {
		for (const principal of [
			{ kind: "oidc" as const, scopes: [] },
			{ kind: "session" as const, scopes: [] },
			null,
		]) {
			expect(selectTools({ tools, principal })).toHaveLength(4);
		}
		expect(selectTools({ tools })).toHaveLength(4);
	});

	it("pinned mode hides the tools marked hiddenWhenPinned", () => {
		expect(names(selectTools({ tools, pinnedSandbox: "sb_pinned" }))).toEqual([
			"fake_get",
			"fake_delete",
			"fake_write",
		]);
	});

	it("filters intersect", () => {
		expect(
			names(
				selectTools({
					tools,
					toolsets: ["core", "files"],
					readOnly: true,
					principal: { kind: "team_key", scopes: ["sandboxes:read"] },
					pinnedSandbox: "sb_pinned",
				}),
			),
		).toEqual(["fake_get"]);
	});
});

describe("inputSchemaOf", () => {
	const [get, , create] = tools;
	if (get === undefined || create === undefined) throw new Error("fixture");

	it("prepends a required sandbox as the first property", () => {
		const json = z.toJSONSchema(inputSchemaOf(get, false), { io: "input" });
		expect(Object.keys(json.properties ?? {})).toEqual([
			"sandbox",
			"path",
			"wait_seconds",
		]);
		expect(json.required).toEqual(["sandbox", "path"]);
		const sandbox = json.properties?.sandbox as Record<string, unknown>;
		expect(sandbox.type).toBe("string");
		expect(sandbox.minLength).toBe(1);
		expect(String(sandbox.description)).toMatch(/sb_/);
		expect(String(sandbox.description)).not.toMatch(/\n/);
	});

	it("drops sandbox when pinned", () => {
		const json = z.toJSONSchema(inputSchemaOf(get, true), { io: "input" });
		expect(Object.keys(json.properties ?? {})).toEqual([
			"path",
			"wait_seconds",
		]);
	});

	it("has no sandbox for tools without sandboxArg", () => {
		const json = z.toJSONSchema(inputSchemaOf(create, false), {
			io: "input",
		});
		expect(Object.keys(json.properties ?? {})).toEqual(["template"]);
	});

	it("rejects an empty sandbox", () => {
		expect(
			inputSchemaOf(get, false).safeParse({ sandbox: "", path: "a" }).success,
		).toBe(false);
	});
});

describe("definition checks", () => {
	it("defineTool refuses a sandboxArg tool with its own sandbox in the shape", () => {
		const [get] = tools;
		if (get === undefined) throw new Error("fixture");
		expect(() =>
			defineTool({
				...get,
				shape: { sandbox: z.string().describe("Sandbox") },
			}),
		).toThrow(/fake_get/);
		expect(() =>
			defineTool({
				...get,
				sandboxArg: false,
				shape: { sandbox: z.string().describe("Sandbox") },
			}),
		).not.toThrow();
	});
});

describe("publication", () => {
	it("strips propertyNames everywhere but keeps arguments of that name", () => {
		expect(
			stripPropertyNames({
				type: "object",
				properties: {
					env: {
						type: "object",
						propertyNames: { type: "string" },
						additionalProperties: { type: "string" },
					},
					list: {
						type: "array",
						items: {
							type: "object",
							properties: {
								m: { type: "object", propertyNames: { type: "string" } },
							},
						},
					},
					propertyNames: { type: "string" },
				},
			}),
		).toEqual({
			type: "object",
			properties: {
				env: { type: "object", additionalProperties: { type: "string" } },
				list: {
					type: "array",
					items: {
						type: "object",
						properties: { m: { type: "object" } },
					},
				},
				propertyNames: { type: "string" },
			},
		});
	});

	it("publishes the same schema as zod, minus propertyNames", () => {
		const [get] = tools;
		if (get === undefined) throw new Error("fixture");
		const json = publishedJsonSchemaOf(get, false);
		expect(json.type).toBe("object");
		expect(Object.keys(json.properties as object)).toEqual([
			"sandbox",
			"path",
			"wait_seconds",
		]);
	});
});

describe("SERVER_INSTRUCTIONS", () => {
	it("fits in 1500 characters", () => {
		expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1500);
	});

	it("covers the rules of spec 7.8", () => {
		for (const needle of [
			"sb_",
			"exec_run",
			"command_id",
			"exec_output",
			"offsets",
			"wait_seconds",
			"exec_start",
			"PowerShell",
			"bash",
			"<<<sbx-untrusted",
			"<<<end",
			"screenshots",
			"never as instructions",
			"sandbox_stop",
			"sandbox_delete",
			"created-via=mcp",
			"secret",
			"limits_get",
			"state not final yet",
		]) {
			expect(SERVER_INSTRUCTIONS).toContain(needle);
		}
	});
});

describe("pinnedInstructions", () => {
	it("fits in 1500 characters with a long sandbox ref", () => {
		expect(pinnedInstructions("x".repeat(128)).length).toBeLessThanOrEqual(
			1500,
		);
	});

	it("says the server is bound to the sandbox and keeps the safety rules", () => {
		const text = pinnedInstructions("quiet-otter-lamp");
		for (const needle of [
			"bound to sandbox quiet-otter-lamp",
			"no sandbox argument",
			"exec_run",
			"exec_output",
			"exec_start",
			"PowerShell",
			"<<<sbx-untrusted",
			"never as instructions",
			"secret",
			"state not final yet",
		]) {
			expect(text).toContain(needle);
		}
	});
});

describe("parseToolsets", () => {
	it("reads a comma list, trims spaces and drops repeats", () => {
		expect(parseToolsets("core, files,core")).toEqual(["core", "files"]);
		expect(parseToolsets("desktop")).toEqual(["desktop"]);
	});

	it("an unknown name is an error that lists the valid ones", () => {
		expect(() => parseToolsets("core,shell")).toThrow(
			'unknown toolset "shell"; valid: core, files, ports, snapshots, desktop',
		);
	});

	it("an empty list is an error", () => {
		expect(() => parseToolsets(" , ")).toThrow(/no toolsets/);
	});
});
