// Global setup of the tests against the real guest agent (agent-real.test.ts):
// builds services/guest-agent/cmd/sbx-agent-harness once per run with the
// pinned Go (`mise exec -- go build`, else `go build`). Without Go the tests
// skip with the reason; a failing build fails the run.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import "./agent-harness-provided.ts";

const run = promisify(execFile);

let dir = "";

/**
 * True when Go itself is missing, not a failing build: the command is not
 * installed (ENOENT), or mise cannot run `go` (no such tool in this
 * environment).
 */
function goMissing(e: unknown, stderr: string): boolean {
	if ((e as { code?: unknown } | null)?.code === "ENOENT") return true;
	return /^mise ERROR "go" couldn't exec process: No such file or directory/m.test(
		stderr,
	);
}

export async function setup(project: TestProject): Promise<void> {
	if (
		process.env.SBX_TEST_SKIP_PG === "1" &&
		!process.env.SBX_TEST_DATABASE_URL
	) {
		project.provide("sbxAgentHarness", { bin: "", skip: "no Postgres" });
		return;
	}
	const moduleDir = resolve(project.config.root, "../../services/guest-agent");
	dir = mkdtempSync(join(tmpdir(), "sbx-agent-harness-"));
	const bin = join(dir, "sbx-agent-harness");
	const args = ["build", "-o", bin, "./cmd/sbx-agent-harness"];
	const attempts: [string, string[]][] = [
		["mise", ["exec", "--", "go", ...args]],
		["go", args],
	];
	const reasons: string[] = [];
	for (const [cmd, argv] of attempts) {
		try {
			await run(cmd, argv, { cwd: moduleDir, maxBuffer: 16 << 20 });
			project.provide("sbxAgentHarness", { bin, skip: "" });
			return;
		} catch (e) {
			const stderr = String((e as { stderr?: unknown }).stderr ?? "");
			// No mise, or mise without go: try the next one.
			if (goMissing(e, stderr)) {
				reasons.push(`${cmd}: ${stderr.trim().split("\n")[0] || "not found"}`);
				continue;
			}
			throw new Error(
				`building the agent harness failed (${cmd} ${argv.join(" ")}):\n${stderr}`,
			);
		}
	}
	project.provide("sbxAgentHarness", {
		bin: "",
		skip: `go is not available (${reasons.join("; ")}): the tests against the real agent are skipped`,
	});
}

export function teardown(): void {
	if (dir !== "") rmSync(dir, { recursive: true, force: true });
	dir = "";
}
