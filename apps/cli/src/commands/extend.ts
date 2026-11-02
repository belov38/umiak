// `umiak extend [<sb>] [--ttl <duration>]` (S7 §8.2): a new deadline, now +
// ttl (default: the sandbox's own TTL).

import type { Command } from "commander";
import { parseDuration } from "../args.ts";
import { sandboxRef, writeCurrent } from "../current.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("extend")
		.description("move the TTL deadline of a sandbox")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.option("--ttl <duration>", "new deadline from now: 3600, 90m, 2h, 7d")
		.action(
			run(async (ctx, args, opts) => {
				const ref = sandboxRef(ctx, args[0] as string | undefined);
				const ttl = opts.ttl as string | undefined;
				const { data } = await ctx
					.umiak()
					.raw.POST("/v1/sandboxes/{sandbox}/extend", {
						params: { path: { sandbox: ref.ref } },
						body:
							ttl === undefined
								? {}
								: { ttlSeconds: parseDuration(ttl, "--ttl") },
					});
				if (ref.explicit) writeCurrent(ctx, data.id);
				ctx.out.result(
					data,
					(v) => `${v.slug} (${v.id}): deadline ${v.deadlineAt ?? "none"}`,
				);
			}),
		);
}
