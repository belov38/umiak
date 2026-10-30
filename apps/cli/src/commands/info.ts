// `sbx info [<sb>]`: the sandbox resource (S7 §8.1).

import type { Command } from "commander";
import { useSandbox } from "../current.ts";
import { sandboxText } from "../format.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("info")
		.description("show a sandbox")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.action(
			run(async (ctx, args) => {
				const sb = await useSandbox(ctx, args[0] as string | undefined);
				ctx.out.result(sb.data, sandboxText);
			}),
		);
}
