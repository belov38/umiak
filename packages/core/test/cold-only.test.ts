import { describe, expect, it } from "vitest";
import { validateCreateInput } from "../src/service/create-input.ts";

describe("cold-only create input", () => {
	it("rejects the removed internal failFast option", () => {
		expect(() => validateCreateInput({ failFast: true } as never)).toThrow();
	});
});
