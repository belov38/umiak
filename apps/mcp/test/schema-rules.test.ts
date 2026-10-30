import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inputSchemaOf } from "../src/registry.ts";
import { lintToolName, lintToolSchema } from "../src/schema-rules.ts";
import { fakeTools } from "./helpers/fake-tools.ts";

const obj = (properties: Record<string, unknown>, extra = {}) => ({
	type: "object",
	properties,
	...extra,
});

describe("lintToolSchema", () => {
	it("accepts the allowed subset", () => {
		const schema = obj(
			{
				name: { type: "string", description: "Name", maxLength: 10 },
				count: {
					type: "integer",
					description: "Count",
					minimum: 0,
					maximum: 5,
				},
				ratio: { type: "number", description: "Ratio" },
				force: { type: "boolean", description: "Force" },
				mode: { type: "string", enum: ["a", "b"], description: "Mode" },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Paths",
				},
				labels: {
					type: "object",
					additionalProperties: { type: "string" },
					description: "Labels",
				},
				region: {
					type: "object",
					description: "Region",
					properties: { x: { type: "integer", description: "X" } },
					required: ["x"],
				},
				actions: {
					type: "array",
					description: "Actions",
					items: {
						type: "object",
						properties: { kind: { type: "string", description: "Kind" } },
					},
				},
			},
			{ required: ["name"] },
		);
		expect(lintToolSchema("t", schema)).toEqual([]);
	});

	it("finds anyOf and the other composite keywords", () => {
		const v = lintToolSchema(
			"t",
			obj({
				a: {
					anyOf: [{ type: "string" }, { type: "integer" }],
					description: "A",
				},
				b: { oneOf: [{ type: "string" }], description: "B" },
			}),
		);
		expect(v.some((m) => m.includes("anyOf") && m.includes("a"))).toBe(true);
		expect(v.some((m) => m.includes("oneOf") && m.includes("b"))).toBe(true);
		for (const key of ["allOf", "not", "$ref", "$defs", "if", "then", "else"]) {
			const found = lintToolSchema(
				"t",
				obj({ x: { type: "string", description: "X", [key]: {} } }),
			);
			expect(found.join("\n")).toContain(key);
		}
		expect(
			lintToolSchema("t", {
				...obj({}),
				$defs: { a: { type: "string" } },
			}).join("\n"),
		).toContain("$defs");
	});

	it("finds an array type", () => {
		const v = lintToolSchema(
			"t",
			obj({ ttl: { type: ["integer", "null"], description: "TTL" } }),
		);
		expect(v.join("\n")).toMatch(/ttl.*type/);
	});

	it("finds nullable", () => {
		const v = lintToolSchema(
			"t",
			obj({ ttl: { type: "integer", nullable: true, description: "TTL" } }),
		);
		expect(v.join("\n")).toContain("nullable");
	});

	it("finds a property without description, also nested and in array items", () => {
		expect(
			lintToolSchema("t", obj({ path: { type: "string" } })).join("\n"),
		).toMatch(/path.*description/);
		expect(
			lintToolSchema(
				"t",
				obj({
					region: {
						type: "object",
						description: "Region",
						properties: { x: { type: "integer" } },
					},
				}),
			).join("\n"),
		).toMatch(/region\.x.*description/);
		expect(
			lintToolSchema(
				"t",
				obj({
					actions: {
						type: "array",
						description: "Actions",
						items: {
							type: "object",
							properties: { kind: { type: "string" } },
						},
					},
				}),
			).join("\n"),
		).toMatch(/actions\[\]\.kind.*description/);
	});

	it("finds a numeric enum", () => {
		const v = lintToolSchema(
			"t",
			obj({ level: { type: "integer", enum: [1, 2], description: "Level" } }),
		);
		expect(v.join("\n")).toMatch(/level.*enum/);
	});

	it("finds a root that is not an object", () => {
		expect(lintToolSchema("t", { type: "string" }).join("\n")).toMatch(
			/root.*object/,
		);
		expect(lintToolSchema("t", null).join("\n")).toMatch(/root.*object/);
	});

	it("finds property names that are not snake_case", () => {
		const v = lintToolSchema(
			"t",
			obj({
				waitSeconds: { type: "integer", description: "W" },
				_x: { type: "integer", description: "X" },
			}),
		);
		expect(v.join("\n")).toContain("waitSeconds");
		expect(v.join("\n")).toContain("_x");
	});

	it("prefixes every message with the tool name", () => {
		const v = lintToolSchema("fake_tool", obj({ a: { type: "string" } }));
		expect(v.length).toBeGreaterThan(0);
		for (const m of v) expect(m.startsWith("fake_tool: ")).toBe(true);
	});

	it("accepts the published schemas of the fake tools", () => {
		for (const t of fakeTools().tools) {
			for (const pinned of [false, true]) {
				const json = z.toJSONSchema(inputSchemaOf(t, pinned), { io: "input" });
				expect(lintToolSchema(t.name, json)).toEqual([]);
			}
		}
	});

	it("catches what zod makes of nullable and unions", () => {
		const json = z.toJSONSchema(
			z.object({
				a: z.number().nullable().describe("A"),
				b: z.union([z.string(), z.number()]).describe("B"),
			}),
			{ io: "input" },
		);
		// zod folds unions of primitives into a type array; either is caught.
		const v = lintToolSchema("t", json);
		expect(v.some((m) => m.startsWith("t: a: "))).toBe(true);
		expect(v.some((m) => m.startsWith("t: b: "))).toBe(true);
	});
});

describe("lintToolName", () => {
	it("accepts snake_case up to 40 characters", () => {
		expect(lintToolName("exec_run")).toEqual([]);
		expect(lintToolName(`a${"b".repeat(39)}`)).toEqual([]);
	});

	it("rejects other names", () => {
		for (const name of [
			"",
			"Exec_run",
			"exec-run",
			"1exec",
			"exec.run",
			`a${"b".repeat(40)}`,
		]) {
			expect(lintToolName(name)).toHaveLength(1);
		}
	});
});
