import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Qga } from "@sbx/pve";
import { table } from "./report.ts";

// sbx-bench s9 agent-tests (spec S9 section 18.3): the Windows test binaries of the guest agent
// (services/guest-agent/test/windows/build-tests.sh) are copied into a running clone over QGA and
// run there as SYSTEM, which is what qemu-ga exec runs as.

/** Guest directory of the binaries. Paths for Qga.fileWriteWindows must not contain spaces. */
export const REMOTE_DIR = "C:\\sbx-tests";
/** Passed to every binary as -test.timeout; the exec timeout is a minute longer. */
export const TEST_TIMEOUT = "5m";
const EXEC_TIMEOUT_MS = 6 * 60_000;
const BIN_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.test\.exe$/;

export interface AgentTestsOptions {
	vmid: number;
	/** Local directory with the *.test.exe files. */
	dir: string;
}

export interface AgentTestsDeps {
	qga: Pick<Qga, "exec" | "fileWriteWindows">;
	/** Defaults to the real directory listing and file reads. */
	files?: {
		list(dir: string): string[];
		read(path: string): Buffer;
	};
	out?: (text: string) => void;
	log?: (text: string) => void;
	now?: () => number;
}

export interface BinaryResult {
	name: string;
	exitCode: number | null;
	ms: number;
	error?: string;
}

const realFiles = {
	list: (dir: string) => readdirSync(dir),
	read: (path: string) => readFileSync(path),
};

const powershell = (script: string): string[] => [
	"powershell",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	script,
];

/** Copies and runs every `*.test.exe` of the directory. Returns 0 when all passed, else 1. */
export async function runAgentTests(
	deps: AgentTestsDeps,
	o: AgentTestsOptions,
): Promise<number> {
	const { qga } = deps;
	const files = deps.files ?? realFiles;
	const out = deps.out ?? ((s: string) => process.stdout.write(s));
	const log =
		deps.log ??
		((s: string) =>
			process.stderr.write(
				`[${new Date().toISOString().slice(11, 19)}] ${s}\n`,
			));
	const now = deps.now ?? Date.now;

	const bins = files
		.list(o.dir)
		.filter((f) => f.endsWith(".test.exe"))
		.sort();
	if (bins.length === 0) throw new Error(`no *.test.exe files in ${o.dir}`);
	const bad = bins.find((b) => !BIN_NAME_RE.test(b));
	if (bad)
		throw new Error(`unsupported test binary name ${JSON.stringify(bad)}`);

	const results: BinaryResult[] = [];
	try {
		const mk = await qga.exec(
			o.vmid,
			powershell(
				`New-Item -ItemType Directory -Force -Path ${REMOTE_DIR} | Out-Null`,
			),
		);
		if (mk.exitCode !== 0)
			throw new Error(
				`creating ${REMOTE_DIR} on VM ${o.vmid} failed: exit ${mk.exitCode}: ${mk.stderr.trim()}`,
			);
		for (const name of bins) {
			const remote = `${REMOTE_DIR}\\${name}`;
			const t0 = now();
			try {
				log(`${name}: copy`);
				await qga.fileWriteWindows(
					o.vmid,
					remote,
					files.read(join(o.dir, name)),
				);
				log(`${name}: run`);
				const r = await qga.exec(
					o.vmid,
					[remote, "-test.v", "-test.timeout", TEST_TIMEOUT],
					{ timeoutMs: EXEC_TIMEOUT_MS },
				);
				out(`=== ${name} (exit ${r.exitCode})\n${r.stdout}`);
				if (r.stderr.trim() !== "") out(`--- stderr\n${r.stderr}`);
				results.push({ name, exitCode: r.exitCode, ms: now() - t0 });
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				out(`=== ${name}: ${error}\n`);
				results.push({ name, exitCode: null, ms: now() - t0, error });
			}
		}
	} finally {
		// Best effort: the clone is usually deleted afterwards anyway.
		await qga
			.exec(
				o.vmid,
				powershell(
					`Remove-Item -Recurse -Force -LiteralPath ${REMOTE_DIR} -ErrorAction SilentlyContinue`,
				),
			)
			.catch((err: unknown) =>
				log(`removing ${REMOTE_DIR} failed: ${String(err)}`),
			);
	}

	out(
		`\n${table(
			["binary", "result", "seconds"],
			results.map((r) => [
				r.name,
				r.exitCode === 0
					? "ok"
					: r.exitCode === null
						? "ERROR"
						: `FAIL (exit ${r.exitCode})`,
				(r.ms / 1000).toFixed(1),
			]),
		)}\n`,
	);
	return results.every((r) => r.exitCode === 0) ? 0 : 1;
}
