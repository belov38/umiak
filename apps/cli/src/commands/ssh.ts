// `sbx ssh [<sb>] [-- ssh args]` (S7 §11.3, §14.2): logs in through the SSH
// gateway with the system `ssh` and a throwaway key:
//   1. `ssh-keygen` makes an ed25519 key in a new 0700 temporary directory;
//   2. the api certifies it for this sandbox (about 10 min, checked at login);
//   3. the known_hosts cache is refreshed from /v1/meta;
//   4. `ssh -i <key> -o CertificateFile=<cert> -o IdentitiesOnly=yes
//      -o UserKnownHostsFile=<cache> -p <port> <slug>@<host> [ssh args]`
//      runs in this terminal (the words after `--` follow the destination:
//      ssh options such as `-L 3000:localhost:3000`, or a remote command);
//   5. the directory is removed when ssh exits.
// Works with a team key too. sbx exits with ssh's code. Ctrl-C belongs to
// ssh; SIGTERM and SIGHUP (the terminal closed) are passed on to ssh. sbx
// survives them until ssh exits, so the key is always removed (see sshInto).

import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { splitDashDash } from "../args.ts";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { CliError, usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import {
	certify,
	knownHostsName,
	refreshKnownHosts,
	sshKeygen,
	TOOL_MISSING,
} from "../ssh.ts";

/** Exit code of a signal on this machine (128 + n), as a shell reports it. */
function signalExit(sig: NodeJS.Signals | null): number {
	return 128 + (sig ? (constants.signals[sig] ?? 0) : 0);
}

/**
 * Runs the system ssh with `argv` on this terminal; resolves to its exit
 * code. `onChild` gets the process (for passing signals on).
 */
function runSsh(
	argv: string[],
	onChild: (c: ChildProcess) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", argv, { stdio: "inherit" });
		onChild(child);
		child.once("error", (err) => {
			reject(
				new CliError({
					code: TOOL_MISSING,
					message: `cannot run ssh (${err.message}): install OpenSSH`,
					retryable: false,
				}),
			);
		});
		child.once("close", (code, signal) => {
			resolve(code ?? signalExit(signal));
		});
	});
}

/**
 * The key, its certificate and ssh. From the temporary directory on, sbx
 * does not die of SIGINT, SIGTERM or SIGHUP: while ssh runs, SIGINT is left
 * to ssh (it reaches the whole foreground group) and SIGTERM/SIGHUP are
 * passed on to it; before that, they stop the preparation. Either way the
 * directory is removed and sbx exits 128 + n (or with ssh's code).
 */
async function sshInto(
	ctx: Context,
	ref: string | undefined,
	extra: string[],
): Promise<number> {
	const sb = await useSandbox(ctx, ref);
	const ac = new AbortController();
	let child: ChildProcess | undefined;
	let caught: NodeJS.Signals | undefined;
	const onSignal = (sig: NodeJS.Signals) => {
		if (child !== undefined) {
			if (sig !== "SIGINT" && child.exitCode === null) child.kill(sig);
			return;
		}
		caught ??= sig;
		ac.abort();
	};
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const sig of signals) process.on(sig, onSignal);
	const dir = mkdtempSync(join(tmpdir(), "sbx-ssh-"));
	try {
		chmodSync(dir, 0o700);
		const key = join(dir, "id_ed25519");
		sshKeygen(key, `sbx-${sb.slug}`);
		ac.signal.throwIfAborted();
		const cert = await certify(
			ctx,
			sb.id,
			readFileSync(`${key}.pub`, "utf8"),
			key,
			ac.signal,
		);
		const knownHosts = await refreshKnownHosts(ctx, cert);
		ac.signal.throwIfAborted();
		return await runSsh(
			[
				"-i",
				key,
				"-o",
				`CertificateFile=${key}-cert.pub`,
				"-o",
				"IdentitiesOnly=yes",
				"-o",
				`UserKnownHostsFile=${knownHosts}`,
				"-p",
				String(cert.port),
				`${cert.username}@${cert.host}`,
				...extra,
			],
			(c) => {
				child = c;
			},
		);
	} catch (err) {
		if (caught !== undefined) return signalExit(caught);
		throw err;
	} finally {
		for (const sig of signals) process.off(sig, onSignal);
		rmSync(dir, { recursive: true, force: true });
	}
}

export function register(program: Command, run: Runner): void {
	program
		.command("ssh")
		.description(
			"log in to a sandbox with the system ssh and a short-lived certificate: sbx ssh [<sb>] [-- ssh args]",
		)
		.argument("[args...]", "sandbox ID or slug, then -- and arguments of ssh")
		.addHelpText(
			"after",
			[
				"",
				"The words after -- follow the destination: ssh options or a remote command.",
				"  sbx ssh my-sb -- -L 3000:localhost:3000",
				"  sbx ssh my-sb -- uname -a",
				`The gateway's host keys are cached in <config dir>/known_hosts (${knownHostsName("ssh.example.com", 2222)} for a port other than 22).`,
			].join("\n"),
		)
		.action(
			run(
				async (ctx, args) => {
					const { before, after } = splitDashDash(
						ctx.argv,
						(args[0] as string[]) ?? [],
					);
					if (before.length > 1) {
						throw usageError(
							`unexpected ${JSON.stringify(before[1])}: put ssh arguments after --`,
						);
					}
					return sshInto(ctx, before[0], after ?? []);
				},
				{ rawData: true },
			),
		);
}
