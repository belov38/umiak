import { describe, expect, it } from "vitest";
import { splitBudget, truncationNote } from "../src/output/budget.ts";

describe("splitBudget", () => {
	it("gives the unused part of the short stream to the long one", () => {
		expect(splitBudget(16384, { stdout: 100000, stderr: 912 })).toEqual({
			stdout: 15472,
			stderr: 912,
		});
		expect(splitBudget(16384, { stdout: 912, stderr: 100000 })).toEqual({
			stdout: 912,
			stderr: 15472,
		});
	});

	it("splits in halves when both are long", () => {
		expect(splitBudget(16384, { stdout: 50000, stderr: 50000 })).toEqual({
			stdout: 8192,
			stderr: 8192,
		});
	});

	it("never exceeds the stream sizes", () => {
		expect(splitBudget(16384, { stdout: 10, stderr: 20 })).toEqual({
			stdout: 10,
			stderr: 20,
		});
		expect(splitBudget(100, { stdout: 0, stderr: 0 })).toEqual({
			stdout: 0,
			stderr: 0,
		});
	});

	it("never exceeds max with an odd budget", () => {
		const r = splitBudget(101, { stdout: 1000, stderr: 1000 });
		expect(r.stdout + r.stderr).toBe(101);
	});
});

describe("truncationNote", () => {
	it("returns null without truncation", () => {
		expect(
			truncationNote("stdout", { from: 0, to: 100, size: 100, mode: "tail" }),
		).toBeNull();
		expect(
			truncationNote("stdout", { from: 0, to: 0, size: 0, mode: "forward" }),
		).toBeNull();
	});

	it("describes a tail cut", () => {
		expect(
			truncationNote("stdout", {
				from: 172344,
				to: 182344,
				size: 182344,
				mode: "tail",
			}),
		).toBe(
			"stdout: last 10000 of 182344 bytes. Earlier output: exec_output with stdout_offset=0.",
		);
	});

	it("describes a forward window", () => {
		expect(
			truncationNote("stderr", {
				from: 100,
				to: 600,
				size: 2000,
				mode: "forward",
			}),
		).toBe(
			"stderr: bytes 100–600 of 2000. Earlier output: exec_output with stderr_offset=0. Later output: exec_output with stderr_offset=600.",
		);
	});

	it("omits hints that do not apply to a forward window", () => {
		expect(
			truncationNote("stdout", {
				from: 0,
				to: 500,
				size: 2000,
				mode: "forward",
			}),
		).toBe(
			"stdout: bytes 0–500 of 2000. Later output: exec_output with stdout_offset=500.",
		);
		expect(
			truncationNote("stdout", {
				from: 1500,
				to: 2000,
				size: 2000,
				mode: "forward",
			}),
		).toBe(
			"stdout: bytes 1500–2000 of 2000. Earlier output: exec_output with stdout_offset=0.",
		);
	});
});
