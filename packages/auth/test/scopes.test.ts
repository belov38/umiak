import { describe, expect, it } from "vitest";
import { isScope, PRESETS, SANDBOX_SELF_PRESET, SCOPES } from "../src/index.ts";

describe("SCOPES", () => {
	it("has the 14 v1 scopes in contract order", () => {
		expect([...SCOPES]).toEqual([
			"sandboxes:read",
			"sandboxes:write",
			"sandboxes:delete",
			"commands:read",
			"commands:exec",
			"files:read",
			"files:write",
			"ports:write",
			"ssh:connect",
			"snapshots:read",
			"snapshots:write",
			"environments:read",
			"environments:write",
			"keys:admin",
		]);
	});

	it("isScope narrows known names only", () => {
		expect(isScope("keys:admin")).toBe(true);
		expect(isScope("keys:Admin")).toBe(false);
		expect(isScope("desktop")).toBe(false);
		expect(isScope("")).toBe(false);
	});
});

describe("PRESETS (S7 §7.3)", () => {
	it("read-only", () => {
		expect([...PRESETS["read-only"]]).toEqual([
			"sandboxes:read",
			"commands:read",
			"files:read",
			"snapshots:read",
			"environments:read",
		]);
	});

	it("ci", () => {
		expect([...PRESETS.ci]).toEqual([
			"sandboxes:read",
			"sandboxes:write",
			"sandboxes:delete",
			"commands:read",
			"commands:exec",
			"files:read",
			"files:write",
			"ports:write",
			"snapshots:read",
			"environments:read",
		]);
	});

	it("full is every scope", () => {
		expect([...PRESETS.full]).toEqual([...SCOPES]);
	});

	it("sandbox-self is reserved and not among the issued presets", () => {
		expect(Object.keys(PRESETS).sort()).toEqual(["ci", "full", "read-only"]);
		expect([...SANDBOX_SELF_PRESET]).toEqual([
			"sandboxes:read",
			"commands:read",
			"commands:exec",
			"files:read",
			"files:write",
			"ports:write",
		]);
	});
});
