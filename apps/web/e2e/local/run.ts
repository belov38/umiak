// Isolated fake-backend acceptance; never connects to Proxmox.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../..", import.meta.url));
const compose = [
	"compose",
	"--project-name",
	process.env.UMIAK_E2E_PROJECT ?? "umiak-local-e2e",
	"--env-file",
	"deploy/compose/e2e.env",
	...["compose.yaml", "e2e.yaml", "local.yaml", "local-e2e.yaml"].flatMap(
		(f) => ["-f", `deploy/compose/${f}`],
	),
];
const run = (cmd: string, args: string[]) =>
	spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status ?? 1;
let code = 1;
try {
	code = run("docker", [...compose, "up", "-d", "--build", "--wait"]);
	if (code === 0)
		code = run("pnpm", [
			"--filter",
			"@umiak/web",
			"exec",
			"playwright",
			"test",
			"-c",
			"e2e/local",
		]);
} finally {
	run("docker", [...compose, "down", "-v", "--remove-orphans"]);
}
process.exit(code);
