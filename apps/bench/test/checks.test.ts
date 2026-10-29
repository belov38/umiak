import { describe, expect, it } from "vitest";
import { parseDmi } from "../src/checks.ts";

describe("parseDmi", () => {
	it("reads labelled serial and uuid and lowercases the uuid", () => {
		expect(parseDmi("serial=sbx1:abc:def\nuuid=AB-CD\n")).toEqual({
			serial: "sbx1:abc:def",
			uuid: "ab-cd",
		});
	});
	it("returns empty strings when a field is missing", () => {
		expect(parseDmi("uuid=x\n")).toEqual({ serial: "", uuid: "x" });
	});
});
