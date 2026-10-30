import { describe, expect, it } from "vitest";
import { hostAddresses, parseDmi } from "../src/checks.ts";

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

describe("hostAddresses", () => {
	it("keeps the default management address and adds SBX_NODE_SSH_HOST and SBX_BENCH_HOST_ADDRESSES", () => {
		expect(hostAddresses({}, "100.1.2.3")).toEqual(["100.1.2.3"]);
		expect(
			hostAddresses(
				{
					SBX_NODE_SSH_HOST: "192.168.68.90",
					SBX_BENCH_HOST_ADDRESSES: " 10.0.0.5  100.1.2.3 ",
				},
				"100.1.2.3",
			),
		).toEqual(["100.1.2.3", "192.168.68.90", "10.0.0.5"]);
		expect(hostAddresses({ SBX_NODE_SSH_HOST: "" }, "100.1.2.3")).toEqual([
			"100.1.2.3",
		]);
	});
});
