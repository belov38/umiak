// `sbx ssh-keys list|add [file]|rm <key>...` (S7 §11.3, §14.2): the SSH
// keys of the person logged in, for plain `ssh <slug>@<gateway>` without
// sbx. Team keys have none (they use `sbx ssh` certificates).
// - add: default ~/.ssh/id_ed25519.pub; the name is --name, else the key's
//   comment, else the file name.
// - rm: by id (`sshk_…`), name or fingerprint.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { components } from "@sbx/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { CliError, usageError } from "../exit-codes.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

type SshKey = components["schemas"]["SshKey"];

async function listKeys(ctx: Context): Promise<SshKey[]> {
	const { data } = await ctx.sbx().raw.GET("/v1/ssh-keys");
	return data.data;
}

function defaultKeyFile(ctx: Context): string {
	const home = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
	return join(home, ".ssh", "id_ed25519.pub");
}

/** The id of a key given as id, name or fingerprint. */
async function keyId(
	ctx: Context,
	ref: string,
	cache: { keys?: SshKey[] },
): Promise<string> {
	if (ref.startsWith("sshk_")) return ref;
	cache.keys ??= await listKeys(ctx);
	const k = cache.keys.find((x) => x.name === ref || x.fingerprint === ref);
	if (k === undefined) {
		throw new CliError({
			code: "not_found",
			message: `no SSH key ${JSON.stringify(ref)}; see sbx ssh-keys list`,
			retryable: false,
		});
	}
	return k.id;
}

export function register(program: Command, run: Runner): void {
	const keys = program
		.command("ssh-keys")
		.description("SSH keys of your user, for plain ssh to the gateway");

	keys
		.command("list")
		.alias("ls")
		.description("list your SSH keys")
		.action(
			run(async (ctx) => {
				const data = await listKeys(ctx);
				ctx.out.result({ data }, (v) =>
					v.data.length === 0
						? "no SSH keys; add one with: sbx ssh-keys add"
						: table(
								["NAME", "TYPE", "FINGERPRINT", "ID", "LAST USED"],
								v.data.map((k) => [
									k.name,
									k.type,
									k.fingerprint,
									k.id,
									k.lastUsedAt,
								]),
							),
				);
			}),
		);

	keys
		.command("add")
		.description("add a public key (default ~/.ssh/id_ed25519.pub)")
		.argument("[file]", "public key file")
		.option("--name <name>", "name of the key (default: its comment)")
		.action(
			run(async (ctx, args, opts) => {
				const file = (args[0] as string | undefined) ?? defaultKeyFile(ctx);
				let text: string;
				try {
					text = readFileSync(file, "utf8");
				} catch (err) {
					throw usageError(`cannot read ${file}: ${(err as Error).message}`);
				}
				const line = text
					.split(/\r?\n/)
					.map((l) => l.trim())
					.find((l) => l !== "" && !l.startsWith("#"));
				if (line === undefined) throw usageError(`${file} holds no public key`);
				const comment = line.split(/\s+/).slice(2).join(" ");
				const name =
					(opts.name as string | undefined) ??
					(comment === "" ? basename(file) : comment);
				const { data } = await ctx.sbx().raw.POST("/v1/ssh-keys", {
					body: { name: name.slice(0, 100), publicKey: line },
				});
				ctx.out.result(
					data,
					(k) => `added ${k.name} (${k.fingerprint}) ${k.id}`,
				);
			}),
		);

	keys
		.command("rm")
		.description("remove SSH keys by id, name or fingerprint")
		.argument("<key...>", "key id (sshk_…), name or fingerprint")
		.action(
			run(async (ctx, args) => {
				const cache: { keys?: SshKey[] } = {};
				for (const ref of args[0] as string[]) {
					const id = await keyId(ctx, ref, cache);
					await ctx.sbx().raw.DELETE("/v1/ssh-keys/{key}", {
						params: { path: { key: id } },
					});
					ctx.out.result({ id, deleted: true }, (v) => `removed ${v.id}`);
				}
			}),
		);
}
