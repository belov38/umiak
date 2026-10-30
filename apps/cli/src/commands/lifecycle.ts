// `sbx stop|resume|recover [<sb>] [--wait]` and `sbx fork [<sb>] [--wait]`
// (S7 §8.2, §14.2, §14.3). Without --wait each prints the action's answer
// (`{sandbox, operation}`, fork also `sourceOperation`); with --wait the
// JSON Lines `accepted`, `state`…, last `ready` (`stopped` for stop).
// An explicit <sb> becomes current; fork makes the copy current.

import { newIdempotencyKey } from "@sbx/sdk";
import type { Command } from "commander";
import { collect, envSet, parseDuration, parsePairs } from "../args.ts";
import type { Context } from "../context.ts";
import { sandboxRef, writeCurrent } from "../current.ts";
import { sandboxLine } from "../format.ts";
import type { Runner } from "../program.ts";
import { reportWait } from "../wait.ts";

interface WaitFlags {
	wait?: boolean;
	waitTimeout?: string;
}

interface SetFlags {
	env?: string[];
	secret?: string[];
	envFile?: string[];
}

function waitTimeout(f: WaitFlags): number | undefined {
	return f.waitTimeout === undefined
		? undefined
		: parseDuration(f.waitTimeout, "--wait-timeout") * 1000;
}

function addWait(c: Command, what: string): Command {
	return c
		.option(
			"--wait",
			`wait until it is ${what} (JSON Lines: accepted, state, ${what})`,
		)
		.option("--wait-timeout <duration>", "limit of --wait (default 5m)");
}

function addSets(c: Command): Command {
	return c
		.option("--env <K=V>", "set an env variable (repeatable)", collect)
		.option("--secret <K=V>", "set a secret variable (repeatable)", collect)
		.option(
			"--env-file <file>",
			"env variables from a dotenv file (repeatable)",
			collect,
		);
}

/** The env/secret patch of the flags (merged by key on the api). */
function setsPatch(f: SetFlags) {
	const out: {
		env?: Record<string, string>;
		secrets?: Record<string, string>;
	} = {};
	const env = envSet(f.envFile, f.env);
	if (Object.keys(env).length > 0) out.env = env;
	if (f.secret !== undefined) out.secrets = parsePairs(f.secret, "--secret");
	return out;
}

type Action = "stop" | "resume" | "recover";

async function action(
	ctx: Context,
	kind: Action,
	arg: string | undefined,
	body: Record<string, unknown> | undefined,
	f: WaitFlags,
): Promise<void> {
	const ref = sandboxRef(ctx, arg);
	const params = { params: { path: { sandbox: ref.ref } } };
	const sbx = ctx.sbx();
	const { data } =
		kind === "stop"
			? await sbx.raw.POST("/v1/sandboxes/{sandbox}/stop", params)
			: kind === "resume"
				? await sbx.raw.POST("/v1/sandboxes/{sandbox}/resume", {
						...params,
						body: body ?? {},
					})
				: await sbx.raw.POST("/v1/sandboxes/{sandbox}/recover", params);
	if (ref.explicit) writeCurrent(ctx, data.sandbox.id);
	if (f.wait === true) {
		await reportWait(
			ctx,
			data,
			kind === "stop" ? "stopped" : "ready",
			waitTimeout(f),
		);
		return;
	}
	ctx.out.result(data, (v) => `${v.operation.kind}: ${sandboxLine(v.sandbox)}`);
}

export function register(program: Command, run: Runner): void {
	addWait(
		program
			.command("stop")
			.description("stop a sandbox (its disk is kept)")
			.argument("[sb]", "sandbox ID or slug (default: the current one)"),
		"stopped",
	).action(
		run(async (ctx, args, opts) => {
			await action(ctx, "stop", args[0] as string | undefined, undefined, opts);
		}),
	);

	addSets(
		addWait(
			program
				.command("resume")
				.description("start a stopped sandbox again")
				.argument("[sb]", "sandbox ID or slug (default: the current one)")
				.option("--size <slug>", "another size allowed for the template")
				.option("--ttl <duration>", "lifetime from ready: 3600, 90m, 2h, 7d"),
			"ready",
		),
	).action(
		run(async (ctx, args, opts) => {
			const f = opts as SetFlags & WaitFlags & { size?: string; ttl?: string };
			const body: Record<string, unknown> = { ...setsPatch(f) };
			if (f.size !== undefined) body.size = f.size;
			if (f.ttl !== undefined) body.ttlSeconds = parseDuration(f.ttl, "--ttl");
			await action(ctx, "resume", args[0] as string | undefined, body, f);
		}),
	);

	addWait(
		program
			.command("recover")
			.description("restart a sandbox whose machine is stuck or lost")
			.argument("[sb]", "sandbox ID or slug (default: the current one)"),
		"ready",
	).action(
		run(async (ctx, args, opts) => {
			await action(
				ctx,
				"recover",
				args[0] as string | undefined,
				undefined,
				opts,
			);
		}),
	);

	addSets(
		addWait(
			program
				.command("fork")
				.description("copy a sandbox into a new one (the copy becomes current)")
				.argument("[sb]", "sandbox ID or slug (default: the current one)")
				.option("--name <name>", "display name of the copy")
				.option("--slug <slug>", "slug of the copy")
				.option(
					"--label <k=v>",
					"label of the copy (repeatable; default: the source's)",
					collect,
				)
				.option("--size <slug>", "size of the copy")
				.option("--ttl <duration>", "lifetime of the copy from ready")
				.option("--idle <duration>", "stop the copy after this long idle"),
			"ready",
		),
	).action(
		run(async (ctx, args, opts) => {
			const f = opts as SetFlags &
				WaitFlags & {
					name?: string;
					slug?: string;
					label?: string[];
					size?: string;
					ttl?: string;
					idle?: string;
				};
			const body: Record<string, unknown> = { ...setsPatch(f) };
			if (f.name !== undefined) body.name = f.name;
			if (f.slug !== undefined) body.slug = f.slug;
			if (f.label !== undefined) body.labels = parsePairs(f.label, "--label");
			if (f.size !== undefined) body.size = f.size;
			if (f.ttl !== undefined) body.ttlSeconds = parseDuration(f.ttl, "--ttl");
			if (f.idle !== undefined) {
				body.idleTimeoutSeconds = parseDuration(f.idle, "--idle");
			}
			const ref = sandboxRef(ctx, args[0] as string | undefined);
			const { data } = await ctx
				.sbx()
				.raw.POST("/v1/sandboxes/{sandbox}/fork", {
					params: { path: { sandbox: ref.ref } },
					body,
					idempotencyKey: newIdempotencyKey(),
				});
			writeCurrent(ctx, data.sandbox.id);
			if (f.wait === true) {
				await reportWait(ctx, data, "ready", waitTimeout(f));
				return;
			}
			ctx.out.result(data, (v) => `Forking into ${sandboxLine(v.sandbox)}`);
		}),
	);
}
