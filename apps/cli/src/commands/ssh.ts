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
// ssh: sbx ignores SIGINT meanwhile so that it still cleans up.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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

/** Runs the system ssh with `argv` on this terminal; resolves to its exit code. */
function runSsh(argv: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const ignore = () => {};
		process.on("SIGINT", ignore);
		const child = spawn("ssh", argv, { stdio: "inherit" });
		const done = () => process.off("SIGINT", ignore);
		child.once("error", (err) => {
			done();
			reject(
				new CliError({
					code: TOOL_MISSING,
					message: `cannot run ssh (${err.message}): install OpenSSH`,
					retryable: false,
				}),
			);
		});
		child.once("close", (code, signal) => {
			done();
			// A local signal: the local number, as a shell reports it.
			resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
		});
	});
}

async function sshInto(
	ctx: Context,
	ref: string | undefined,
	extra: string[],
): Promise<number> {
	const sb = await useSandbox(ctx, ref);
	const dir = mkdtempSync(join(tmpdir(), "sbx-ssh-"));
	try {
		chmodSync(dir, 0o700);
		const key = join(dir, "id_ed25519");
		sshKeygen(key, `sbx-${sb.slug}`);
		const cert = await certify(ctx, sb.id, key);
		const knownHosts = await refreshKnownHosts(ctx, cert);
		return await runSsh([
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
		]);
	} finally {
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
