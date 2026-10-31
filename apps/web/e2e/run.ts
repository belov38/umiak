// `pnpm --filter @sbx/web test:e2e`: brings the E2E stack up
// (deploy/compose/e2e.yaml, project sbx-e2e), runs Playwright against it and
// tears it down with its volumes. Extra arguments go to `playwright test`.
//   SBX_E2E_KEEP=1   keep the stack after the run (then re-run with
//                    `pnpm exec playwright test -c e2e`)
//   SBX_E2E_LARGE=1  upload 100 MiB instead of 70 MiB
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const compose = fileURLToPath(
	new URL("../../../deploy/compose/", import.meta.url),
);
const web = fileURLToPath(new URL("..", import.meta.url));
const base = [
	"compose",
	"--env-file",
	`${compose}e2e.env`,
	"-f",
	`${compose}compose.yaml`,
	"-f",
	`${compose}e2e.yaml`,
];

function run(cmd: string, args: string[], cwd = web): number {
	const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
	return r.status ?? 1;
}

let code = run("docker", [...base, "up", "-d", "--build", "--wait"]);
if (code === 0) {
	code = run("pnpm", [
		"exec",
		"playwright",
		"test",
		"-c",
		"e2e",
		...process.argv.slice(2),
	]);
} else {
	run("docker", [...base, "logs", "--tail", "100"]);
}
if (process.env.SBX_E2E_KEEP === "1") {
	console.error("SBX_E2E_KEEP=1: the stack sbx-e2e keeps running");
} else {
	run("docker", [...base, "down", "-v", "--remove-orphans"]);
}
process.exit(code);
