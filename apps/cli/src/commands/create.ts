// `sbx create` (S7 §8.2, §14.2): POST /v1/sandboxes with an Idempotency-Key.
// Without --wait prints the answer `{sandbox, operation}`; with --wait the
// JSON Lines `accepted`, `state`…, last `ready`. The new sandbox becomes the
// current one of this shell. The create flags are shared with `sbx run`.

import type { CreateSandboxInput } from "@sbx/sdk";
import { newIdempotencyKey } from "@sbx/sdk";
import type { Command } from "commander";
import { collect, envSet, parseDuration, parsePairs } from "../args.ts";
import type { Context } from "../context.ts";
import { writeCurrent } from "../current.ts";
import { sandboxLine } from "../format.ts";
import type { Runner } from "../program.ts";
import { reportWait } from "../wait.ts";

export interface CreateFlags {
	template?: string;
	size?: string;
	name?: string;
	slug?: string;
	label?: string[];
	env?: string[];
	secret?: string[];
	envFile?: string[];
	ttl?: string;
	idle?: string;
	from?: string;
	/** A name, or false for --no-environment. */
	environment?: string | false;
}

/** The options of `create` (also `run`). */
export function addCreateOptions(c: Command): Command {
	return c
		.option("--template <slug>", "template (default: the platform default)")
		.option("--size <slug>", "size (default: the template's default)")
		.option("--name <name>", "display name")
		.option("--slug <slug>", "slug (default: three random words)")
		.option("--label <k=v>", "label (repeatable)", collect)
		.option("--env <K=V>", "env variable (repeatable)", collect)
		.option(
			"--secret <K=V>",
			"secret variable, kept on tmpfs (repeatable)",
			collect,
		)
		.option(
			"--env-file <file>",
			"env variables from a dotenv file (repeatable)",
			collect,
		)
		.option("--ttl <duration>", "lifetime from ready: 3600, 90m, 2h, 7d")
		.option("--idle <duration>", "stop after this long idle (at least 60 s)")
		.option("--from <snapshot>", "create from a saved snapshot")
		.option("--environment <name>", "apply this environment (env-sets)")
		.option("--no-environment", "apply no environment, not even the default");
}

/** The create request of the flags. */
export function createBody(f: CreateFlags): CreateSandboxInput {
	const body: CreateSandboxInput = {};
	if (f.template !== undefined) body.template = f.template;
	if (f.size !== undefined) body.size = f.size;
	if (f.name !== undefined) body.name = f.name;
	if (f.slug !== undefined) body.slug = f.slug;
	if (f.label !== undefined) body.labels = parsePairs(f.label, "--label");
	const env = envSet(f.envFile, f.env);
	if (Object.keys(env).length > 0) body.env = env;
	if (f.secret !== undefined) body.secrets = parsePairs(f.secret, "--secret");
	if (f.ttl !== undefined) body.ttlSeconds = parseDuration(f.ttl, "--ttl");
	if (f.idle !== undefined) {
		body.idleTimeoutSeconds = parseDuration(f.idle, "--idle");
	}
	if (f.from !== undefined) body.from = { snapshot: f.from };
	if (f.environment === false) body.environment = null;
	else if (f.environment !== undefined) body.environment = f.environment;
	return body;
}

/** POST /v1/sandboxes; the answer `{sandbox, operation}`. */
export async function createSandbox(ctx: Context, body: CreateSandboxInput) {
	const { data } = await ctx.sbx().raw.POST("/v1/sandboxes", {
		body,
		idempotencyKey: newIdempotencyKey(),
	});
	return data;
}

export function register(program: Command, run: Runner): void {
	addCreateOptions(program.command("create").description("create a sandbox"))
		.option(
			"--wait",
			"wait until it is ready (JSON Lines: accepted, state, ready)",
		)
		.option("--wait-timeout <duration>", "limit of --wait (default 5m)")
		.action(
			run(async (ctx, _args, opts) => {
				const f = opts as CreateFlags & {
					wait?: boolean;
					waitTimeout?: string;
				};
				const timeout =
					f.waitTimeout === undefined
						? undefined
						: parseDuration(f.waitTimeout, "--wait-timeout") * 1000;
				const res = await createSandbox(ctx, createBody(f));
				writeCurrent(ctx, res.sandbox.id);
				if (f.wait === true) {
					await reportWait(ctx, res, "ready", timeout);
					return;
				}
				ctx.out.result(res, (v) => `Creating ${sandboxLine(v.sandbox)}`);
			}),
		);
}
