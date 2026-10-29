import { describe, expect, it } from "vitest";
import { classifyBearer } from "../src/index.ts";

describe("classifyBearer", () => {
	it("sbx_ is a team key", () => {
		expect(classifyBearer(`sbx_${"a".repeat(49)}`)).toBe("team_key");
		expect(classifyBearer("sbx_garbage")).toBe("team_key");
	});

	it("sbxs_ is reserved", () => {
		expect(classifyBearer(`sbxs_${"a".repeat(49)}`)).toBe("reserved");
	});

	it("three non-empty base64url parts are a jwt", () => {
		expect(classifyBearer("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln-_x")).toBe(
			"jwt",
		);
	});

	it("everything else is invalid", () => {
		for (const t of [
			"",
			"abc",
			"a.b",
			"a.b.c.d",
			"a..c",
			".b.c",
			"a.b.",
			"a.b.c=",
			"a.b c.d",
			"a.b+c.d",
			"Bearer a.b.c",
		]) {
			expect(classifyBearer(t), t).toBe("invalid");
		}
	});

	it("is case-sensitive on the prefix", () => {
		expect(classifyBearer("SBX_abc")).toBe("invalid");
	});
});
