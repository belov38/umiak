import { describe, expect, it } from "vitest";
import { operationDeadline } from "../src/index.ts";

const MIN = 60_000;

describe("operationDeadline (S6 §7.9)", () => {
	it.each([
		["create", "linux", 6 * MIN],
		["create", "windows", 20 * MIN],
		["fork", "linux", 2 * MIN],
		["fork", "windows", 3 * MIN],
		["stop", "linux", 3 * MIN],
		["stop", "windows", 7 * MIN],
		["resume", "linux", 5 * MIN],
		["resume", "windows", 15 * MIN],
		["recover", "linux", 5 * MIN],
		["recover", "windows", 15 * MIN],
		["reprovision", "linux", 5 * MIN],
		["reprovision", "windows", 15 * MIN],
		["save_snapshot", "linux", 5 * MIN],
		["save_snapshot", "windows", 5 * MIN],
	] as const)("%s %s -> %d ms", (kind, os, ms) => {
		expect(operationDeadline(kind, os)).toBe(ms);
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
