// Tool schema compatibility with the four target clients (S11 7.1, 7.2,
// 14.1): the published tools/list is checked against the rule sets of
// helpers/client-rules.ts. The schema linter of 7.2 comes first: it is the
// common minimum, the client rules add what is specific to a client.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintToolName, lintToolSchema } from "../src/schema-rules.ts";
import {
	ALL_CLIENTS,
	CLAUDE_CODE,
	CODEX,
	checkClient,
	combineRules,
	GEMINI_CLI,
	GEMINI_KEYWORDS,
	type JsonObject,
	OPENAI_KEYWORDS,
	OPENCODE,
	SERVER_NAME,
	stripKeywords,
	validDraft2020,
	walkSchema,
} from "./helpers/client-rules.ts";
import { type Harness, startHarness } from "./helpers/harness.ts";

let h: Harness;
let tools: { name: string; inputSchema: JsonObject }[];

beforeAll(async () => {
	h = await startHarness();
	const listed = await h.conn.client.listTools();
	tools = listed.tools.map((t) => ({
		name: t.name,
		inputSchema: t.inputSchema as JsonObject,
	}));
});

afterAll(async () => {
	await h?.close();
});

describe("published tools", () => {
	it("all 38 are listed", () => {
		expect(tools).toHaveLength(38);
	});

	it("every tool passes the 7.2 schema linter and the name rule", () => {
		for (const t of tools) {
			expect(lintToolName(t.name), t.name).toEqual([]);
			expect(lintToolSchema(t.name, t.inputSchema), t.name).toEqual([]);
		}
	});

	it("every schema is valid draft 2020-12 JSON Schema", () => {
		for (const t of tools)
			expect(validDraft2020(t.inputSchema), t.name).toEqual([]);
	});
});

describe.each(ALL_CLIENTS)("$client", (rules) => {
	it("takes every tool", () => {
		const problems = tools.flatMap((t) =>
			checkClient(rules, t.name, t.inputSchema),
		);
		expect(problems).toEqual([]);
	});
});

describe("Claude Code", () => {
	it("names are mcp__sbx__<tool>, at most 64 characters, [a-zA-Z0-9_-]", () => {
		for (const t of tools) {
			const q = CLAUDE_CODE.qualifiedName(t.name);
			expect(q).toBe(`mcp__${SERVER_NAME}__${t.name}`);
			expect(q.length).toBeLessThanOrEqual(64);
			expect(q).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
		}
	});

	it("every root is an object", () => {
		for (const t of tools) expect(t.inputSchema.type, t.name).toBe("object");
	});
});

describe("Codex and OpenCode (OpenAI function parameters)", () => {
	it("every array has items and no keyword outside the OpenAI set is used", () => {
		for (const t of tools) {
			walkSchema(t.inputSchema, (n, path) => {
				if (n.type === "array")
					expect(n.items, `${t.name} ${path}`).toBeTypeOf("object");
				for (const k of Object.keys(n)) {
					expect(OPENAI_KEYWORDS.has(k), `${t.name} ${path}: ${k}`).toBe(true);
				}
			});
		}
	});

	it("the checker catches what it should", () => {
		const bad = {
			type: "object",
			properties: {
				list: { type: "array", description: "x" },
				odd: { type: "string", description: "x", unevaluatedProperties: false },
			},
		} as JsonObject;
		const codex = checkClient(CODEX, "t", bad);
		expect(codex.join("\n")).toContain("array without items");
		expect(codex.join("\n")).toContain("keyword unevaluatedProperties");
		const long = "x".repeat(60);
		expect(
			checkClient(CLAUDE_CODE, long, { type: "object", properties: {} }).join(),
		).toContain("characters (max 64)");
		expect(
			checkClient(CLAUDE_CODE, "bad name", {
				type: "object",
				properties: {},
			}).join(),
		).toContain("does not match");
		expect(
			checkClient(CLAUDE_CODE, "t", { type: "string" }).join("\n"),
		).toContain("root type is not object");
	});
});

describe("Gemini CLI", () => {
	it("after dropping $schema and additionalProperties only the Gemini keywords remain", () => {
		for (const t of tools) {
			const sent = stripKeywords(t.inputSchema, [
				"$schema",
				"additionalProperties",
			]);
			walkSchema(sent, (n, path) => {
				for (const k of Object.keys(n)) {
					expect(GEMINI_KEYWORDS.has(k), `${t.name} ${path}: ${k}`).toBe(true);
				}
			});
		}
	});

	it("the stripped schema is still valid JSON Schema with the same required", () => {
		for (const t of tools) {
			expect(checkClient(GEMINI_CLI, t.name, t.inputSchema), t.name).toEqual(
				[],
			);
			const sent = GEMINI_CLI.transform?.(t.inputSchema) as JsonObject;
			expect(sent.required ?? [], t.name).toEqual(t.inputSchema.required ?? []);
			expect(JSON.stringify(sent)).not.toContain("additionalProperties");
			expect(sent).not.toHaveProperty("$schema");
		}
	});

	it("dictionaries (env, labels) stay objects with a description once additionalProperties is gone", () => {
		const create = tools.find(
			(t) => t.name === "sandbox_create",
		) as (typeof tools)[number];
		const sent = GEMINI_CLI.transform?.(create.inputSchema) as JsonObject;
		const props = sent.properties as Record<string, JsonObject>;
		for (const name of ["env", "labels"]) {
			expect(props[name]?.type, name).toBe("object");
			expect(props[name]?.description, name).toBeTypeOf("string");
		}
	});

	it("rejects a keyword outside the subset and a changed required", () => {
		const bad = {
			type: "object",
			required: ["a"],
			properties: {
				a: { type: "string", description: "x", exclusiveMinimum: 1 },
			},
		} as JsonObject;
		expect(checkClient(GEMINI_CLI, "t", bad).join("\n")).toContain(
			"keyword exclusiveMinimum",
		);
	});
});

describe("checker branches", () => {
	it("reports a changed required and an invalid transformed schema", () => {
		const schema = {
			type: "object",
			required: ["a"],
			properties: { a: { type: "string", description: "x" } },
		} as JsonObject;
		const dropsRequired = {
			...GEMINI_CLI,
			transform: (s: JsonObject) => {
				const { required: _required, ...rest } = s;
				return rest;
			},
		};
		expect(checkClient(dropsRequired, "t", schema).join("\n")).toContain(
			"required changed",
		);
		const breaks = {
			...GEMINI_CLI,
			transform: (s: JsonObject): JsonObject => ({ ...s, type: "nonsense" }),
		};
		expect(checkClient(breaks, "t", schema).join("\n")).toContain(
			"not valid JSON Schema",
		);
	});

	it("OpenCode is the union of the Anthropic and OpenAI rules", () => {
		const both = combineRules("both", (n) => n, CLAUDE_CODE, CODEX);
		expect(OPENCODE.namePatterns).toEqual(both.namePatterns);
		expect(OPENCODE.namePatterns).toHaveLength(2);
		expect(OPENCODE.arraysNeedItems).toBe(true);
		expect(OPENCODE.allowedKeywords).toEqual(OPENAI_KEYWORDS);
		// Stricter than either alone: the shortest limit and the narrower keyword set.
		const strict = combineRules(
			"strict",
			(n) => n,
			{ ...CLAUDE_CODE, nameMaxLength: 10 },
			{ ...CODEX, allowedKeywords: new Set(["type", "properties"]) },
		);
		expect(strict.nameMaxLength).toBe(10);
		expect([...(strict.allowedKeywords ?? [])].sort()).toEqual([
			"properties",
			"type",
		]);
		const problems = checkClient(strict, "a_long_tool_name", {
			type: "object",
			properties: { s: { type: "string", description: "x" } },
		});
		expect(problems.join("\n")).toContain("characters (max 10)");
		expect(problems.join("\n")).toContain("keyword description");
	});
});
