// `sbx ssh-config [<sb>]` (S7 §11.3, §14.2): prints an ssh_config block for
// plain `ssh sbx-<slug>` and VS Code Remote-SSH (append it to
// ~/.ssh/config):
//
//   Host sbx-<slug>
//     HostName <gateway host>
//     Port <port>
//     User <slug>
//     IdentitiesOnly yes
//     UserKnownHostsFile <config dir>/known_hosts
//   Match originalhost sbx-<slug> exec "sbx ssh-cert <sb_id> --ensure"
//     IdentityFile <config dir>/ssh/<sb_id>/id_ed25519
//     CertificateFile <config dir>/ssh/<sb_id>/id_ed25519-cert.pub
//
// ssh runs the `Match exec` on each connection to that alias only
// (`originalhost`: a bare `Match exec` would run for every host), and it
// gets a fresh certificate when the old one is about to expire. The global
// flags given here (--profile, --api-url, --team, --cacert,
// --credential-store) are repeated in it; credentials from the env
// (SBX_API_KEY) are not, so use a profile. stdout is the block whatever
// the terminal; `--json` prints {host, config}.

import { join, resolve } from "node:path";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import type { Runner } from "../program.ts";
import { knownHostsFile, refreshKnownHosts } from "../ssh.ts";
import { certDir } from "./ssh-cert.ts";

/** A value of ssh_config: quoted when it has blanks. */
function value(v: string): string {
	return /[\s"]/.test(v) ? `"${v.replaceAll('"', '\\"')}"` : v;
}

/** The `sbx` to run from ssh: this binary when compiled, else `sbx` on PATH. */
function sbxCommand(): string {
	const exe = process.execPath;
	const name = exe.split(/[\\/]/).pop() ?? "";
	return /^sbx(-|\.exe$|$)/.test(name) ? exe : "sbx";
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
			"print an ssh_config block (Host sbx-<slug>) for plain ssh and VS Code",
		)
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.action(
			run(
				async (ctx, args) => {
					const sb = await useSandbox(ctx, args[0] as string | undefined);
					const { data: ssh } = await ctx
						.sbx()
						.raw.GET("/v1/sandboxes/{sandbox}/ssh", {
							params: { path: { sandbox: sb.id } },
						});
					await refreshKnownHosts(ctx, ssh);
					const alias = `sbx-${sb.slug}`;
					const dir = certDir(ctx, sb.id);
					const ensure = [
						sbxCommand(),
						...globalFlags(ctx).map(value),
						"ssh-cert",
						sb.id,
						"--ensure",
					].join(" ");
					const config = [
						`Host ${alias}`,
						`  HostName ${ssh.host}`,
						`  Port ${ssh.port}`,
						`  User ${ssh.username}`,
						"  IdentitiesOnly yes",
						`  UserKnownHostsFile ${value(knownHostsFile(ctx))}`,
						`Match originalhost ${alias} exec "${ensure.replaceAll('"', '\\"')}"`,
						`  IdentityFile ${value(join(dir, "id_ed25519"))}`,
						`  CertificateFile ${value(join(dir, "id_ed25519-cert.pub"))}`,
						"",
					].join("\n");
					if (ctx.out.jsonFlag) ctx.out.result({ host: alias, config });
					else await ctx.out.data(config);
				},
				{ rawData: true },
			),
		);
}
