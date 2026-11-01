import { describe, expect, it } from "vitest";
import { operationDeadline } from "../src/index.ts";

const MIN = 60_000;

describe("operationDeadline (S6 §7.9)", () => {
	it.each([
		["create", "linux", true, 2 * MIN],
		["create", "windows", true, 5 * MIN],
		["create", "linux", false, 6 * MIN],
		["create", "windows", false, 20 * MIN],
		["fork", "linux", false, 2 * MIN],
		["fork", "windows", false, 3 * MIN],
		["stop", "linux", false, 3 * MIN],
		["stop", "windows", false, 7 * MIN],
		["resume", "linux", false, 5 * MIN],
		["resume", "windows", false, 15 * MIN],
		["recover", "linux", false, 5 * MIN],
		["recover", "windows", false, 15 * MIN],
		["reprovision", "linux", false, 5 * MIN],
		["reprovision", "windows", false, 15 * MIN],
		["save_snapshot", "linux", false, 5 * MIN],
		["save_snapshot", "windows", false, 5 * MIN],
	] as const)("%s %s fromPool=%s -> %d ms", (kind, os, fromPool, ms) => {
		expect(operationDeadline(kind, os, { fromPool })).toBe(ms);
	});

	it("forceStop adds the stop deadline to fork and save_snapshot", () => {
		expect(operationDeadline("fork", "windows", { forceStop: true })).toBe(
			10 * MIN,
		);
		expect(
			operationDeadline("save_snapshot", "windows", { forceStop: true }),
		).toBe(12 * MIN);
	});

	it("delete has no deadline", () => {
		expect(operationDeadline("delete", "linux")).toBeNull();
		expect(operationDeadline("delete", "windows")).toBeNull();
	});
});
