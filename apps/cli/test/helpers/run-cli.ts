// Runs the real CLI (`bun src/main.ts`) as a child process with a hermetic
// home: its own XDG_CONFIG_HOME, XDG_STATE_HOME, a missing system config,
// the file credential store (the OS keychain is never touched) and a fixed
// shell key. `tty: true` makes the CLI treat stdout as a terminal (UMIAK_TTY).

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.env.UMIAK_TEST_BUN ?? "bun";

export interface CliHome {
	dir: string;
	configDir: string;
	stateDir: string;
	/** The hermetic env of this home (merge your own over it). */
	env: Record<string, string>;
	rm(): void;
}

export function cliHome(): CliHome {
	const dir = mkdtempSync(join(tmpdir(), "umiak-cli-"));
	const configDir = join(dir, "config");
	const stateDir = join(dir, "state");
	return {
		dir,
		configDir: join(configDir, "umiak"),
		stateDir: join(stateDir, "umiak"),
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dir,
			XDG_CONFIG_HOME: configDir,
			XDG_STATE_HOME: stateDir,
			UMIAK_SYSTEM_CONFIG: join(dir, "system-config.json"),
			UMIAK_CREDENTIAL_STORE: "file",
			UMIAK_SESSION: "test-shell",
		},
		rm: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export interface RunOptions {
	/** The whole env of the process (start from `cliHome().env`); undefined removes. */
	env: Record<string, string | undefined>;
	stdin?: string;
	/** Gets the child process (to send it signals). */
	onSpawn?: (child: ChildProcess) => void;
	/** Write `stdin` but keep the pipe open until the process exits. */
	stdinOpen?: boolean;
	/** Treat stdout as a terminal (default: not, as a pipe is). */
	tty?: boolean;
	timeoutMs?: number;
	/** Close the read end of stdout after this many bytes (`| head -c N`). */
	closeStdoutAfter?: number;
	/** Working directory of the CLI (default apps/cli). */
	cwd?: string;
}

export interface CliResult {
	code: number;
	stdout: string;
	/** stdout as bytes. */
	stdoutBytes: Buffer;
	stderr: string;
	/** stdout parsed as JSON Lines. */
	lines(): Record<string, unknown>[];
	/** The last JSON line of stdout. */
	last(): Record<string, unknown>;
}

export function runCli(args: string[], o: RunOptions): Promise<CliResult> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
	if (o.tty !== undefined) env.UMIAK_TTY = o.tty ? "1" : "0";
	return new Promise((resolve, reject) => {
		const child = spawn(BUN, [join(CLI_DIR, "src/main.ts"), ...args], {
			cwd: o.cwd ?? CLI_DIR,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		o.onSpawn?.(child);
		const out: Buffer[] = [];
		let stderr = "";
		let got = 0;
		child.stdout.on("data", (b: Buffer) => {
			out.push(b);
			got += b.length;
			if (o.closeStdoutAfter !== undefined && got >= o.closeStdoutAfter) {
				child.stdout.destroy();
			}
		});
		child.stderr.setEncoding("utf8").on("data", (s: string) => {
			stderr += s;
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`umiak ${args.join(" ")} timed out\n${stderr}`));
			// A hang guard only; a spawn on a loaded machine can take seconds.
		}, o.timeoutMs ?? 60_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			const stdoutBytes = Buffer.concat(out);
			const stdout = stdoutBytes.toString("utf8");
			const lines = () =>
				stdout
					.split("\n")
					.filter((l) => l.trim() !== "")
					.map((l) => JSON.parse(l) as Record<string, unknown>);
			resolve({
				code: code ?? -1,
				stdout,
				stdoutBytes,
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
		child.stdin.on("error", () => {});
		if (o.stdinOpen === true) child.stdin.write(o.stdin ?? "");
		else child.stdin.end(o.stdin ?? "");
	});
}
