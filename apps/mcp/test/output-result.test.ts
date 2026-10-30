import { describe, expect, it } from "vitest";
import { capResult, MAX_RESULT_CHARS, toolText } from "../src/output/result.ts";

function textOf(r: { content: { type: string; text?: string }[] }) {
	return r.content
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("");
}

describe("toolText", () => {
	it("emits compact JSON without empty fields", () => {
		const r = toolText({
			command_id: "cmd_1",
			exit_code: 0,
			ok: false,
			a: undefined,
			b: null,
			c: "",
			d: [],
			e: {},
			f: { g: undefined, h: "" },
			stdout: { size: 3, from: 0, to: 3 },
		});
		expect(r.content).toHaveLength(1);
		expect(r.content[0]).toEqual({
			type: "text",
			text: '{"command_id":"cmd_1","exit_code":0,"ok":false,"stdout":{"size":3,"from":0,"to":3}}',
		});
	});

	it("appends extra strings as further text blocks", () => {
		const r = toolText({ a: 1 }, ["note", "data"]);
		expect(r.content).toEqual([
			{ type: "text", text: '{"a":1}' },
			{ type: "text", text: "note" },
			{ type: "text", text: "data" },
		]);
	});

	it("keeps non-empty arrays and zero", () => {
		const r = toolText({ list: [1], n: 0 });
		expect(r.content[0]).toEqual({ type: "text", text: '{"list":[1],"n":0}' });
	});
});

describe("capResult", () => {
	it("returns small results unchanged", () => {
		const r = toolText({ a: 1 }, ["x"]);
		expect(capResult(r)).toEqual(r);
	});

	it("cuts 100000 characters to at most the limit with a marker", () => {
		const r = toolText({ a: 1 }, ["x".repeat(100_000)]);
		const out = capResult(r);
		const all = textOf(out);
		expect(all.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
		expect(all).toContain("response cut at 80000 characters");
		expect(out.content[0]).toEqual({ type: "text", text: '{"a":1}' });
	});

	it("cuts the last text blocks first and drops later ones", () => {
		const r = toolText({ a: 1 }, ["a".repeat(50_000), "b".repeat(50_000), "c"]);
		const out = capResult(r);
		const texts = out.content.map((b) => (b.type === "text" ? b.text : ""));
		expect(texts[0]).toBe('{"a":1}');
		expect(texts[1]).toBe("a".repeat(50_000));
		expect(texts[2]?.startsWith("b")).toBe(true);
		expect(texts).not.toContain("c");
		expect(textOf(out).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
	});

	it("leaves images untouched and does not count them", () => {
		const image = {
			type: "image" as const,
			data: "z".repeat(200_000),
			mimeType: "image/jpeg",
		};
		const r = { content: [{ type: "text" as const, text: "hi" }, image] };
		expect(capResult(r)).toEqual(r);
		const big = {
			content: [image, { type: "text" as const, text: "y".repeat(90_000) }],
		};
		const out = capResult(big);
		expect(out.content[0]).toEqual(image);
		expect(textOf(out).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
	});

	it("does not split a surrogate pair", () => {
		const r = toolText({}, ["😀".repeat(50_000)]);
		const out = capResult(r);
		const t = textOf(out);
		expect(t.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t)).toBe(false);
	});

	it("keeps other result fields", () => {
		const r = { ...toolText({ a: 1 }, ["x".repeat(100_000)]), isError: true };
		expect(capResult(r).isError).toBe(true);
	});
});
