// Runs the real CLI (`bun src/main.ts`) as a child process with a hermetic
// home: its own XDG_CONFIG_HOME, XDG_STATE_HOME, a missing system config,
// the file credential store (the OS keychain is never touched) and a fixed
// shell key. `tty: true` makes the CLI treat stdout as a terminal (SBX_TTY).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.env.SBX_TEST_BUN ?? "bun";

export interface CliHome {
	dir: string;
	configDir: string;
	stateDir: string;
	/** The hermetic env of this home (merge your own over it). */
	env: Record<string, string>;
	rm(): void;
}

export function cliHome(): CliHome {
	const dir = mkdtempSync(join(tmpdir(), "sbx-cli-"));
	const configDir = join(dir, "config");
	const stateDir = join(dir, "state");
	return {
		dir,
		configDir: join(configDir, "sbx"),
		stateDir: join(stateDir, "sbx"),
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			XDG_CONFIG_HOME: configDir,
			XDG_STATE_HOME: stateDir,
			SBX_SYSTEM_CONFIG: join(dir, "system-config.json"),
			SBX_CREDENTIAL_STORE: "file",
			SBX_SESSION: "test-shell",
		},
		rm: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export interface RunOptions {
	/** The whole env of the process (start from `cliHome().env`); undefined removes. */
	env: Record<string, string | undefined>;
	stdin?: string;
	/** Treat stdout as a terminal (default: not, as a pipe is). */
	tty?: boolean;
	timeoutMs?: number;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout parsed as JSON Lines. */
	lines(): Record<string, unknown>[];
	/** The last JSON line of stdout. */
	last(): Record<string, unknown>;
}

export function runCli(args: string[], o: RunOptions): Promise<CliResult> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
	if (o.tty !== undefined) env.SBX_TTY = o.tty ? "1" : "0";
	return new Promise((resolve, reject) => {
		const child = spawn(BUN, ["src/main.ts", ...args], {
			cwd: CLI_DIR,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (s: string) => {
			stdout += s;
		});
		child.stderr.setEncoding("utf8").on("data", (s: string) => {
			stderr += s;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`sbx ${args.join(" ")} timed out\n${stderr}`));
		}, o.timeoutMs ?? 20_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			const lines = () =>
				stdout
					.split("\n")
					.filter((l) => l.trim() !== "")
					.map((l) => JSON.parse(l) as Record<string, unknown>);
			resolve({
				code: code ?? -1,
				stdout,
				stderr,
				lines,
				last: () => {
					const all = lines();
					const l = all.at(-1);
					if (l === undefined)
						throw new Error(`no JSON on stdout; stderr: ${stderr}`);
					return l;
				},
			});
		});
		child.stdin.end(o.stdin ?? "");
	});
}
