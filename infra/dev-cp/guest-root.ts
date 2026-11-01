// Dev-only guest access for acceptance runners: QGA on the pve host, never the public API.
import { execFileSync } from "node:child_process";
import type { Sandbox } from "../../packages/sdk-ts/src/index.ts";
import { observeDesktop } from "./desktop-observe.ts";

/** One argument for the remote shell of ssh. */
const shq = (a: string) => `'${a.replaceAll("'", "'\\''")}'`;

/** Runs argv as SYSTEM (Windows) or root (Linux) through QGA on the pve host. */
export function guestRoot(
	sb: Sandbox,
	argv: string[],
): { exitcode: number; out: string } {
	const id = Number(observeDesktop(sb.data.slug).runtime_id);
	if (!(id >= 500 && id <= 589)) throw new Error(`unexpected VMID ${id}`);
	const raw = execFileSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"HostKeyAlias=pve.tail0000.ts.net",
			"root@100.64.10.2",
			"qm",
			"guest",
			"exec",
			String(id),
			"--timeout",
			"30",
			"--",
			...argv.map(shq),
		],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 },
	);
	const r = JSON.parse(raw) as { exitcode?: number; "out-data"?: string };
	return { exitcode: r.exitcode ?? -1, out: r["out-data"] ?? "" };
}

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
export const pwsh = (script: string, ...args: string[]) => [
	PWSH,
	"-NoLogo",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	script,
	...args,
];
