import { describe, expect, it } from "vitest";
import { parseLabel, portLabel } from "../src/index.ts";

describe("parseLabel", () => {
	it("splits slug and port", () => {
		expect(parseLabel("my-box-5173")).toEqual({ slug: "my-box", port: 5173 });
		expect(parseLabel("quiet-otter-lamp-1")).toEqual({
			slug: "quiet-otter-lamp",
			port: 1,
		});
		expect(parseLabel("box-65535")).toEqual({ slug: "box", port: 65535 });
	});

	it("rejects labels outside the grammar", () => {
		for (const l of [
			"box-0",
			"box-65536",
			"box-080",
			"box",
			"box-",
			"-80",
			"ab-80",
			"a--b-80",
			"Box-80",
			"api-80",
			"x-desktop-80",
			"box-1-80",
			`${"x".repeat(41)}-80`,
			"box-123456",
			"my.box-80",
		]) {
			expect(parseLabel(l), l).toBeNull();
		}
	});
});

describe("portLabel", () => {
	it("joins slug and port", () => {
		expect(portLabel("my-box", 5173)).toBe("my-box-5173");
		expect(parseLabel(portLabel("quiet-otter-lamp", 8080))).toEqual({
			slug: "quiet-otter-lamp",
			port: 8080,
		});
	});

	it("rejects bad input", () => {
		expect(() => portLabel("my-box", 0)).toThrow();
		expect(() => portLabel("my-box", 65536)).toThrow();
		expect(() => portLabel("my-box", 1.5)).toThrow();
		expect(() => portLabel("box-1", 80)).toThrow();
	});
});
