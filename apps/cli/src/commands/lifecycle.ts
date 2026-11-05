// `umiak stop|resume|recover [<sb>] [--wait]` and `umiak fork [<sb>] [--wait]`
// (S7 §8.2, §14.2, §14.3). Without --wait each prints the action's answer
// (`{sandbox, operation}`, fork also `sourceOperation`); with --wait the
// JSON Lines `accepted`, `state`…, last `ready` (`stopped` for stop).
// An explicit <sb> becomes current; fork makes the copy current.
// fork --force-stop: a running Windows source is stopped for the snapshot and
// started again (S9 §24.8); with --wait a failed restart is a warning.

import { newIdempotencyKey } from "@umiak/sdk";
import type { Command } from "commander";
import { collect, envSet, parseDuration, parsePairs } from "../args.ts";
import type { Context } from "../context.ts";
import { sandboxRef, writeCurrent } from "../current.ts";
import { sandboxLine } from "../format.ts";
import type { Runner } from "../program.ts";
import { reportWait, warnForceStop } from "../wait.ts";

interface WaitFlags {
	wait?: boolean;
	waitReady?: boolean;
	capacityWait?: string;
	waitTimeout?: string;
}

interface SetFlags {
	env?: string[];
	secret?: string[];
	envFile?: string[];
}

/** Help of --force-stop of fork and snapshot save. */
export const FORCE_STOP_HELP =
	"stop a running Windows sandbox, take the snapshot and start it again (running commands and sessions are interrupted; ignored for Linux)";

function waitTimeout(f: WaitFlags): number | undefined {
	return f.waitTimeout === undefined
		? f.capacityWait === undefined
			? undefined
			: parseDuration(f.capacityWait, "--capacity-wait") * 1000 + 300_000
		: parseDuration(f.waitTimeout, "--wait-timeout") * 1000;
}

function addWait(c: Command, what: string): Command {
	return c
		.option(
			"--wait",
			`wait until it is ${what} (JSON Lines: accepted, state, ${what})`,
		)
		.option("--wait-ready", `wait until ${what} (same as --wait)`)
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
	const umiak = ctx.umiak();
	const { data } =
		kind === "stop"
			? await umiak.raw.POST("/v1/sandboxes/{sandbox}/stop", params)
			: kind === "resume"
				? await umiak.raw.POST("/v1/sandboxes/{sandbox}/resume", {
						...params,
						body: body ?? {},
					})
				: await umiak.raw.POST("/v1/sandboxes/{sandbox}/recover", params);
	if (ref.explicit) writeCurrent(ctx, data.sandbox.id);
	if (f.wait === true || f.waitReady === true) {
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
	addSets(
		program
			.command("start")
			.description("start a stopped sandbox, optionally waiting for capacity")
			.argument("[sb]", "sandbox ID or slug (default: the current one)")
			.option(
				"--wait <duration>",
				"queue for capacity and wait until ready, e.g. 100m",
			)
			.option(
				"--capacity-wait <duration>",
				"queue for capacity without waiting for ready",
			)
			.option("--wait-ready", "wait until ready")
			.option(
				"--wait-timeout <duration>",
				"client wait limit (default: capacity wait + 5m)",
			)
			.option("--size <slug>", "another size allowed for the template")
			.option("--ttl <duration>", "lifetime from ready"),
	).action(
		run(async (ctx, args, opts) => {
			const f = opts as SetFlags & {
				wait?: string;
				capacityWait?: string;
				waitReady?: boolean;
				waitTimeout?: string;
				size?: string;
				ttl?: string;
			};
			const duration = f.wait ?? f.capacityWait;
			const body: Record<string, unknown> = { ...setsPatch(f) };
			if (duration !== undefined)
				body.capacityWaitSeconds = parseDuration(
					duration,
					"--wait/--capacity-wait",
				);
			if (f.size !== undefined) body.size = f.size;
			if (f.ttl !== undefined) body.ttlSeconds = parseDuration(f.ttl, "--ttl");
			await action(ctx, "resume", args[0] as string | undefined, body, {
				wait: f.wait !== undefined || f.waitReady === true,
				...(duration === undefined ? {} : { capacityWait: duration }),
				...(f.waitTimeout === undefined ? {} : { waitTimeout: f.waitTimeout }),
			});
		}),
	);
	program
		.command("cancel-start")
		.description("cancel a start that is still waiting for capacity")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.action(
			run(async (ctx, args) => {
				const ref = sandboxRef(ctx, args[0] as string | undefined);
				const { data } = await ctx
					.umiak()
					.raw.POST("/v1/sandboxes/{sandbox}/cancel-start", {
						params: { path: { sandbox: ref.ref } },
					});
				ctx.out.result(
					data,
					(v) => `Cancelled start: ${sandboxLine(v.sandbox)}`,
				);
			}),
		);

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
				.option(
					"--capacity-wait <duration>",
					"queue for capacity for up to this duration (maximum 7d)",
				)
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
			if (f.capacityWait !== undefined)
				body.capacityWaitSeconds = parseDuration(
					f.capacityWait,
					"--capacity-wait",
				);
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
				.option(
					"--capacity-wait <duration>",
					"queue for capacity for up to this duration (maximum 7d)",
				)
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
				.option("--idle <duration>", "stop the copy after this long idle")
				.option("--force-stop", FORCE_STOP_HELP),
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
					forceStop?: boolean;
				};
			const body: Record<string, unknown> = { ...setsPatch(f) };
			if (f.capacityWait !== undefined)
				body.capacityWaitSeconds = parseDuration(
					f.capacityWait,
					"--capacity-wait",
				);
			if (f.name !== undefined) body.name = f.name;
			if (f.slug !== undefined) body.slug = f.slug;
			if (f.label !== undefined) body.labels = parsePairs(f.label, "--label");
			if (f.size !== undefined) body.size = f.size;
			if (f.ttl !== undefined) body.ttlSeconds = parseDuration(f.ttl, "--ttl");
			if (f.idle !== undefined) {
				body.idleTimeoutSeconds = parseDuration(f.idle, "--idle");
			}
			if (f.forceStop === true) body.forceStop = true;
			const ref = sandboxRef(ctx, args[0] as string | undefined);
			const { data } = await ctx
				.umiak()
				.raw.POST("/v1/sandboxes/{sandbox}/fork", {
					params: { path: { sandbox: ref.ref } },
					body,
					idempotencyKey: newIdempotencyKey(),
				});
			writeCurrent(ctx, data.sandbox.id);
			if (f.wait === true || f.waitReady === true) {
				await reportWait(ctx, data, "ready", waitTimeout(f));
				if (data.sourceOperation.forceStop !== null) {
					// Final by now: the fork succeeds before the copy is created.
					const { data: src } = await ctx
						.umiak()
						.raw.GET("/v1/operations/{operation}", {
							params: { path: { operation: data.sourceOperation.id } },
						});
					warnForceStop(ctx, src);
				}
				return;
			}
			ctx.out.result(data, (v) => `Forking into ${sandboxLine(v.sandbox)}`);
		}),
	);
}
