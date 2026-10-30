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

/** True when `cmd` itself is missing (not a failing build). */
function missing(e: unknown): boolean {
	return (e as { code?: unknown } | null)?.code === "ENOENT";
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
			// mise without a go tool, or no mise: try the next one.
			if (missing(e) || /go.*(not found|not installed)/i.test(stderr)) {
				reasons.push(`${cmd}: ${missing(e) ? "not found" : stderr.trim()}`);
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
