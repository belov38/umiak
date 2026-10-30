// `sbx list [--state s,s] [--label k=v]... [--template] [--q] [--limit n]`
// (S7 §8.2): every matching sandbox of the team, newest first, as
// `{data, nextCursor}` (all pages; with --limit the cursor of the rest).

import type { SandboxData } from "@sbx/sdk";
import type { Command } from "commander";
import { collect, parseCount } from "../args.ts";
import { table } from "../format.ts";
import type { Runner } from "../program.ts";

interface ListFlags {
	state?: string;
	label?: string[];
	template?: string;
	q?: string;
	limit?: string;
}

export function register(program: Command, run: Runner): void {
	program
		.command("list")
		.alias("ls")
		.description("list the sandboxes of the team")
		.option("--state <states>", "only these states, comma separated")
		.option(
			"--label <k=v>",
			"only sandboxes with this label (repeatable)",
			collect,
		)
		.option("--template <slug>", "only this template")
		.option("--q <prefix>", "name or slug prefix")
		.option("--limit <n>", "at most this many")
		.action(
			run(async (ctx, _args, opts) => {
				const f = opts as ListFlags;
				const limit =
					f.limit === undefined ? undefined : parseCount(f.limit, "--limit");
				const data: SandboxData[] = [];
				let cursor: string | undefined;
				let nextCursor: string | null = null;
				for (;;) {
					const query: Record<string, unknown> = {};
					if (f.state !== undefined) query.state = f.state;
					if (f.label !== undefined) query.label = f.label;
					if (f.template !== undefined) query.template = f.template;
					if (f.q !== undefined) query.q = f.q;
					query.limit =
						limit === undefined ? 200 : Math.min(limit - data.length, 200);
					if (cursor !== undefined) query.cursor = cursor;
					const { data: page } = await ctx.sbx().raw.GET("/v1/sandboxes", {
						params: { query },
					});
					data.push(...page.data);
					nextCursor = page.nextCursor;
					if (nextCursor === null) break;
					if (limit !== undefined && data.length >= limit) break;
					cursor = nextCursor;
				}
				ctx.out.result({ data, nextCursor }, (v) =>
					v.data.length === 0
						? "No sandboxes."
						: table(
								["SLUG", "ID", "STATE", "TEMPLATE", "SIZE", "CREATED"],
								v.data.map((s) => [
									s.slug,
									s.id,
									s.state,
									s.template,
									s.size,
									s.createdAt,
								]),
							),
				);
			}),
		);
}
