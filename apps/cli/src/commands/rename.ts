// `umiak rename [<sb>] <slug>` (S7 §8.2): PATCH the slug. Published port URLs
// and their cookies change at once.

import type { Command } from "commander";
import { sandboxRef, writeCurrent } from "../current.ts";
import { sandboxLine } from "../format.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("rename")
		.description("change the slug of a sandbox")
		.argument(
			"<sb-or-slug>",
			"sandbox ID or slug, or the new slug for the current sandbox",
		)
		.argument("[slug]", "the new slug")
		.action(
			run(async (ctx, args) => {
				const [a, b] = args as [string, string | undefined];
				const ref = sandboxRef(ctx, b === undefined ? undefined : a);
				const slug = b ?? a;
				const { data } = await ctx
					.umiak()
					.raw.PATCH("/v1/sandboxes/{sandbox}", {
						params: { path: { sandbox: ref.ref } },
						body: { slug },
					});
				if (ref.explicit) writeCurrent(ctx, data.id);
				ctx.out.result(data, sandboxLine);
			}),
		);
}
