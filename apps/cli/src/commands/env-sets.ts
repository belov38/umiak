// `sbx env-sets list|show|create|set|unset|rm` (S8 §10.2): environments of
// the team, named sets of env, secrets and secret files applied at create
// (`sbx create --environment <name>`; the default one applies without it).
// Writes need an owner (or a key with environments:write). Secret values
// are never printed.

import type { components } from "@sbx/sdk";
import type { Command } from "commander";
import { collect, envSet, parsePairs } from "../args.ts";
import type { Context } from "../context.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

interface SetFlags {
	env?: string[];
	secret?: string[];
	envFile?: string[];
}

type Environment = components["schemas"]["Environment"];
type UpdateRequest = components["schemas"]["UpdateEnvironmentRequest"];

function addSets(c: Command): Command {
	return c
		.option("--env <K=V>", "env variable (repeatable)", collect)
		.option("--secret <K=V>", "secret variable (repeatable)", collect)
		.option(
			"--env-file <file>",
			"env variables from a dotenv file (repeatable)",
			collect,
		);
}

function sets(f: SetFlags) {
	const out: {
		env?: Record<string, string>;
		secrets?: Record<string, string>;
	} = {};
	const env = envSet(f.envFile, f.env);
	if (Object.keys(env).length > 0) out.env = env;
	if (f.secret !== undefined) out.secrets = parsePairs(f.secret, "--secret");
	return out;
}

function envText(v: Environment): string {
	const lines = [
		`${v.name} (${v.id})${v.isDefault ? " default" : ""}, revision ${v.revision}`,
	];
	for (const [k, x] of Object.entries(v.env ?? {})) lines.push(`${k}=${x}`);
	for (const k of v.secretKeys) lines.push(`${k}=*** (secret)`);
	return lines.join("\n");
}

async function patch(ctx: Context, ref: string, body: UpdateRequest) {
	const { data } = await ctx.sbx().raw.PATCH("/v1/environments/{environment}", {
		params: { path: { environment: ref } },
		body,
	});
	ctx.out.result(data, envText);
}

export function register(program: Command, run: Runner): void {
	const es = program
		.command("env-sets")
		.description("environments: named env and secret sets applied at create");

	es.command("list")
		.alias("ls")
		.description("list the environments of the team")
		.action(
			run(async (ctx) => {
				const { data } = await ctx.sbx().raw.GET("/v1/environments");
				ctx.out.result(data, (v) =>
					v.data.length === 0
						? "No environments."
						: table(
								["NAME", "ID", "DEFAULT", "REVISION", "ENV", "SECRETS"],
								v.data.map((e) => [
									e.name,
									e.id,
									e.isDefault ? "yes" : "",
									String(e.revision),
									e.envKeys.join(","),
									e.secretKeys.join(","),
								]),
							),
				);
			}),
		);

	es.command("show")
		.description("show an environment with its env values")
		.argument("<env>", "name or ID (env_…)")
		.action(
			run(async (ctx, args) => {
				const { data } = await ctx
					.sbx()
					.raw.GET("/v1/environments/{environment}", {
						params: { path: { environment: args[0] as string } },
					});
				ctx.out.result(data, envText);
			}),
		);

	addSets(
		es
			.command("create")
			.description("create an environment")
			.argument("<name>", "name: ^[a-z0-9][a-z0-9-]{0,62}$")
			.option("--default", "apply it to every create that names no environment")
			.option(
				"--exclude-owner-secrets",
				"do not pass the creator's personal secrets",
			),
	).action(
		run(async (ctx, args, opts) => {
			const body: components["schemas"]["CreateEnvironmentRequest"] = {
				name: args[0] as string,
				...sets(opts),
			};
			if (opts.default === true) body.isDefault = true;
			if (opts.excludeOwnerSecrets === true) body.excludeOwnerSecrets = true;
			const { data } = await ctx.sbx().raw.POST("/v1/environments", {
				body,
			});
			ctx.out.result(data, envText);
		}),
	);

	addSets(
		es
			.command("set")
			.description("set variables of an environment (merged by key)")
			.argument("<env>", "name or ID (env_…)")
			.option("--default", "make it the default environment")
			.option("--no-default", "stop it being the default")
			.option("--rename <name>", "new name"),
	).action(
		run(async (ctx, args, opts) => {
			const body: UpdateRequest = { ...sets(opts) };
			if (opts.default !== undefined) body.isDefault = opts.default === true;
			if (opts.rename !== undefined) body.name = opts.rename as string;
			await patch(ctx, args[0] as string, body);
		}),
	);

	es.command("unset")
		.description("remove variables or secrets of an environment")
		.argument("<env>", "name or ID (env_…)")
		.argument("<key...>", "variable or secret names")
		.action(
			run(async (ctx, args) => {
				const keys = args[1] as string[];
				const gone = Object.fromEntries(keys.map((k) => [k, null]));
				await patch(ctx, args[0] as string, { env: gone, secrets: gone });
			}),
		);

	es.command("rm")
		.description("delete environments")
		.argument("<env...>", "names or IDs (env_…)")
		.action(
			run(async (ctx, args) => {
				for (const ref of args[0] as string[]) {
					await ctx.sbx().raw.DELETE("/v1/environments/{environment}", {
						params: { path: { environment: ref } },
					});
					ctx.out.result(
						{ environment: ref, deleted: true },
						(v) => `Deleted ${v.environment}`,
					);
				}
			}),
		);
}
