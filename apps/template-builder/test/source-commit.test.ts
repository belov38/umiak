import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceCommit } from "../src/source-commit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const noGit = () => {
	const d = mkdtempSync(join(tmpdir(), "umiak-nogit-"));
	dirs.push(d);
	return d;
};

describe("sourceCommit", () => {
	it("uses UMIAK_SOURCE_COMMIT when valid", () => {
		expect(sourceCommit(noGit(), { UMIAK_SOURCE_COMMIT: SHA })).toBe(SHA);
		expect(sourceCommit(noGit(), { UMIAK_SOURCE_COMMIT: `${SHA}-dirty` })).toBe(
			`${SHA}-dirty`,
		);
	});

	it("returns unknown without throwing when git is unavailable", () => {
		expect(sourceCommit(noGit(), {})).toBe("unknown");
	});

	it("ignores an invalid env value", () => {
		expect(sourceCommit(noGit(), { UMIAK_SOURCE_COMMIT: "main" })).toBe(
			"unknown",
		);
	});
});
