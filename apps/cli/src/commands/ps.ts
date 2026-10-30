// `sbx ps [<sb>] [--status s,s] [--limit n]` (S7 §9.4): the commands of a
// sandbox, newest first, as `{data, nextCursor}`. Works on a stopped
// sandbox too (the list is stored).

import type { CommandData } from "@sbx/sdk";
import type { Command } from "commander";
import { parseCount } from "../args.ts";
import { rememberExplicit, sandboxRef } from "../current.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

const DEFAULT_LIMIT = 50;

function shown(c: CommandData): string {
	const text = c.command ?? (c.argv ?? []).join(" ");
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function register(program: Command, run: Runner): void {
	program
		.command("ps")
		.description("list the commands of a sandbox")
		.argument("[sb]", "sandbox ID or slug (default: the current one)")
		.option("--status <statuses>", "only these, comma separated (e.g. running)")
		.option("--limit <n>", `at most this many (default ${DEFAULT_LIMIT})`)
		.action(
			run(async (ctx, args, opts) => {
				const ref = sandboxRef(ctx, args[0] as string | undefined);
				const limit =
					opts.limit === undefined
						? DEFAULT_LIMIT
						: parseCount(opts.limit as string, "--limit");
				const data: CommandData[] = [];
				let cursor: string | undefined;
				let nextCursor: string | null = null;
				do {
					const query: Record<string, unknown> = {
						limit: Math.min(limit - data.length, 200),
					};
					if (opts.status !== undefined) query.status = opts.status;
					if (cursor !== undefined) query.cursor = cursor;
					const { data: page } = await ctx
						.sbx()
						.raw.GET("/v1/sandboxes/{sandbox}/commands", {
							params: { path: { sandbox: ref.ref }, query },
						});
					data.push(...page.data);
					nextCursor = page.nextCursor;
					cursor = nextCursor ?? undefined;
				} while (nextCursor !== null && data.length < limit);
				await rememberExplicit(ctx, ref);
				ctx.out.result({ data, nextCursor }, (v) =>
					v.data.length === 0
						? "No commands."
						: table(
								["ID", "STATUS", "EXIT", "MODE", "STARTED", "COMMAND"],
								v.data.map((c) => [
									c.id,
									c.status,
									c.exitCode === null ? null : String(c.exitCode),
									c.mode,
									c.startedAt,
									shown(c),
								]),
							),
				);
			}),
		);
}
