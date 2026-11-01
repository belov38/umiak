// `umiak env [<sb>] [--set K=V]... [--secret K=V]... [--env-file f]...
// [--unset K]...` (S7 §8.3, S8 C2): without changes GET /env (env values,
// secret names); with changes PATCH /env, merged by key: --unset removes
// the key from env and from secrets. Secret values are never printed.
// Running commands keep their env; new commands see the change.

import type { Command } from "commander";
import { collect, envSet, parsePairs } from "../args.ts";
import { rememberExplicit, sandboxRef } from "../current.ts";
import type { Runner } from "../program.ts";

interface EnvFlags {
	set?: string[];
	secret?: string[];
	envFile?: string[];
	unset?: string[];
}

interface EnvView {
	env: Record<string, string>;
	secretKeys: string[];
	secretFiles: { name: string }[];
	delivered?: boolean;
}

function envText(v: EnvView): string {
	const lines = Object.entries(v.env).map(([k, x]) => `${k}=${x}`);
	for (const k of v.secretKeys) lines.push(`${k}=*** (secret)`);
	for (const f of v.secretFiles) lines.push(`file ${f.name} (secret)`);
	if (v.delivered === false) {
		lines.push("(not delivered yet: applied at the next resume)");
	}
	return lines.length === 0 ? "No variables." : lines.join("\n");
}

export function register(program: Command, run: Runner): void {
	program
		.command("env")
		.description("show or change the env and secrets of a sandbox")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.option("--set <K=V>", "set an env variable (repeatable)", collect)
		.option("--secret <K=V>", "set a secret variable (repeatable)", collect)
		.option(
			"--env-file <file>",
			"set env variables from a dotenv file (repeatable)",
			collect,
		)
		.option("--unset <K>", "remove a variable or secret (repeatable)", collect)
		.action(
			run(async (ctx, args, opts) => {
				const f = opts as EnvFlags;
				const ref = sandboxRef(ctx, args[0] as string | undefined);
				const path = { params: { path: { sandbox: ref.ref } } };
				const env: Record<string, string | null> = envSet(
					f.envFile,
					f.set,
					"--set",
				);
				const secrets: Record<string, string | null> = parsePairs(
					f.secret,
					"--secret",
				);
				for (const k of f.unset ?? []) {
					env[k] = null;
					secrets[k] = null;
				}
				const changes = Object.keys(env).length + Object.keys(secrets).length;
				const { data } =
					changes === 0
						? await ctx.umiak().raw.GET("/v1/sandboxes/{sandbox}/env", path)
						: await ctx.umiak().raw.PATCH("/v1/sandboxes/{sandbox}/env", {
								...path,
								body: {
									...(Object.keys(env).length > 0 ? { env } : {}),
									...(Object.keys(secrets).length > 0 ? { secrets } : {}),
								},
							});
				await rememberExplicit(ctx, ref);
				ctx.out.result(data as EnvView, envText);
			}),
		);
}
