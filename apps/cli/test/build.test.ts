// `scripts/build.ts` (S7 §14.1): `bun build --compile` of the current
// platform into dist/sbx-<os>-<arch>, SHA256SUMS next to it, and the
// compiled binary answers `sbx version`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hostTarget, TARGETS } from "../scripts/build.ts";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUN = process.env.SBX_TEST_BUN ?? "bun";

describe("build", () => {
	it("lists the five release targets and maps the host to one of them", () => {
		expect(TARGETS.map((t) => t.name)).toEqual([
			"linux-x64",
			"linux-arm64",
			"darwin-arm64",
			"darwin-x64",
			"windows-x64",
		]);
		expect(hostTarget("darwin", "arm64").name).toBe("darwin-arm64");
		expect(hostTarget("win32", "x64")).toMatchObject({
			name: "windows-x64",
			bunTarget: "bun-windows-x64",
			file: "sbx-windows-x64.exe",
		});
		expect(() => hostTarget("win32", "arm64")).toThrow(/windows-arm64/);
	});

	it("compiles the current platform; the binary answers sbx version", () => {
		const target = hostTarget(process.platform, process.arch);
		execFileSync(BUN, ["scripts/build.ts"], { cwd: CLI_DIR, stdio: "pipe" });
		const bin = join(CLI_DIR, "dist", target.file);
		expect(existsSync(bin)).toBe(true);
		// A stale binary of another target: SHA256SUMS lists what is there.
		const stale = join(CLI_DIR, "dist", "sbx-test-stale");
		writeFileSync(stale, "old");
		execFileSync(BUN, ["scripts/build.ts"], { cwd: CLI_DIR, stdio: "pipe" });
		rmSync(stale);
		const sums = readFileSync(join(CLI_DIR, "dist", "SHA256SUMS"), "utf8");
		const digest = createHash("sha256").update(readFileSync(bin)).digest("hex");
		expect(sums).toContain(`${digest}  ${target.file}\n`);
		for (const line of sums.trim().split("\n")) {
			const [sum, file] = line.split("  ") as [string, string];
			if (file === "sbx-test-stale") {
				expect(sum).toBe(createHash("sha256").update("old").digest("hex"));
				continue;
			}
			const data = readFileSync(join(CLI_DIR, "dist", file));
			expect(createHash("sha256").update(data).digest("hex")).toBe(sum);
		}
		const out = execFileSync(bin, ["version", "--json"], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: CLI_DIR },
		});
		expect(JSON.parse(out)).toMatchObject({
			version: expect.stringMatching(/^\d+\.\d+\.\d+/),
			platform: `${process.platform}-${process.arch}`,
			runtime: expect.stringMatching(/^bun /),
		});
	}, 120_000);
});
