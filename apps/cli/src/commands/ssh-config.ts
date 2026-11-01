// `umiak ssh-config [<sb>]` (S7 §11.3, §14.2): prints an ssh_config block for
// plain `ssh umiak-<slug>` and VS Code Remote-SSH (append it to
// ~/.ssh/config):
//
//   Host umiak-<slug>
//     HostName <gateway host>
//     Port <port>
//     User <slug>
//     IdentitiesOnly yes
//     UserKnownHostsFile <config dir>/known_hosts
//   Match originalhost umiak-<slug> exec "umiak ssh-cert <sb_id> --ensure"
//     IdentityFile <config dir>/ssh/<sb_id>/id_ed25519
//     CertificateFile <config dir>/ssh/<sb_id>/id_ed25519-cert.pub
//
// ssh runs the `Match exec` on each connection to that alias only
// (`originalhost`: a bare `Match exec` would run for every host), and it
// gets a fresh certificate when the old one is about to expire. The global
// flags given here (--profile, --api-url, --team, --cacert,
// --credential-store) are repeated in it; credentials from the env
// (UMIAK_API_KEY) are not, so use a profile. stdout is the block whatever
// the terminal; `--json` prints {host, config}.

import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import type { Runner } from "../program.ts";
import { knownHostsFile, refreshKnownHosts } from "../ssh.ts";
import { certDir } from "./ssh-cert.ts";

/**
 * A path value of ssh_config: `%` doubled (ssh expands % tokens in these
 * options), and in double quotes with `\` and `"` escaped when it has
 * blanks, quotes or backslashes (ssh's argument splitting).
 */
export function configValue(v: string): string {
	const e = v.replaceAll("%", "%%");
	return /[\s"'\\]/.test(e) ? `"${e.replace(/[\\"]/g, "\\$&")}"` : e;
}

/** POSIX shell quoting of one word (single quotes keep $ and ` literal). */
function shellWord(w: string): string {
	return /^[\w@+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;
}

/**
 * `Match originalhost <alias> exec "<cmd>"` for these words: ssh unquotes
 * the argument, expands % tokens, then runs it with /bin/sh -c. So the words
 * are shell-quoted, `%` doubled, and `\` and `"` escaped for the quotes.
 */
export function matchExecLine(alias: string, words: string[]): string {
	const cmd = words.map(shellWord).join(" ").replaceAll("%", "%%");
	return `Match originalhost ${alias} exec "${cmd.replace(/[\\"]/g, "\\$&")}"`;
}

/** The `umiak` to run from ssh: this binary when compiled, else `umiak` on PATH. */
function umiakCommand(): string {
	const exe = process.execPath;
	const name = exe.split(/[\\/]/).pop() ?? "";
	return /^umiak(-|\.exe$|$)/.test(name) ? exe : "umiak";
}

/** Global flags of this run that the `Match exec` must repeat. */
function globalFlags(ctx: Context): string[] {
	const g = ctx.globals;
	const out: string[] = [];
	if (g.profile !== undefined) out.push("--profile", g.profile);
	if (g.apiUrl !== undefined) out.push("--api-url", g.apiUrl);
	if (g.team !== undefined) out.push("--team", g.team);
	if (g.cacert !== undefined) out.push("--cacert", resolve(g.cacert));
	if (g.credentialStore !== undefined) {
		out.push("--credential-store", g.credentialStore);
	}
	return out;
}

export function register(program: Command, run: Runner): void {
	program
		.command("ssh-config")
		.description(
			"print an ssh_config block (Host umiak-<slug>) for plain ssh and VS Code",
		)
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.action(
			run(
				async (ctx, args) => {
					const sb = await useSandbox(ctx, args[0] as string | undefined);
					const { data: ssh } = await ctx
						.umiak()
						.raw.GET("/v1/sandboxes/{sandbox}/ssh", {
							params: { path: { sandbox: sb.id } },
						});
					await refreshKnownHosts(ctx, ssh);
					const alias = `umiak-${sb.slug}`;
					const dir = certDir(ctx, sb.id);
					const ensure = [
						umiakCommand(),
						...globalFlags(ctx),
						"ssh-cert",
						sb.id,
						"--ensure",
					];
					const config = [
						`Host ${alias}`,
						`  HostName ${ssh.host}`,
						`  Port ${ssh.port}`,
						`  User ${ssh.username}`,
						"  IdentitiesOnly yes",
						`  UserKnownHostsFile ${configValue(knownHostsFile(ctx))}`,
						matchExecLine(alias, ensure),
						`  IdentityFile ${configValue(join(dir, "id_ed25519"))}`,
						`  CertificateFile ${configValue(join(dir, "id_ed25519-cert.pub"))}`,
						"",
					].join("\n");
					if (ctx.out.jsonFlag) ctx.out.result({ host: alias, config });
					else await ctx.out.data(config);
				},
				{ rawData: true },
			),
		);
}
