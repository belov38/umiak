// `sbx label [<sb>] [k=v...] [--unset k]...` (S7 §8.2): merges labels into
// the sandbox's (PATCH replaces them all, so they are read first). Without
// changes prints the labels. A first argument with `=` is a label: the
// sandbox is then the current one.

import type { Command } from "commander";
import { collect, parsePairs } from "../args.ts";
import { useSandbox } from "../current.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("label")
		.description("set or remove labels of a sandbox")
		.argument("[sb-and-labels...]", "sandbox ID or slug, then k=v labels")
		.option("--unset <key>", "remove this label (repeatable)", collect)
		.action(
			run(async (ctx, args, opts) => {
				const words = (args[0] as string[] | undefined) ?? [];
				const first = words[0];
				const arg =
					first !== undefined && !first.includes("=") ? first : undefined;
				const pairs = arg === undefined ? words : words.slice(1);
				const set = parsePairs(pairs, "label");
				const unset = (opts.unset as string[] | undefined) ?? [];
				const sb = await useSandbox(ctx, arg);
				if (pairs.length === 0 && unset.length === 0) {
					ctx.out.result({ labels: sb.data.labels }, (v) =>
						Object.entries(v.labels)
							.map(([k, x]) => `${k}=${x}`)
							.join("\n"),
					);
					return;
				}
				const labels: Record<string, string> = { ...sb.data.labels, ...set };
				for (const k of unset) delete labels[k];
				const { data } = await ctx.sbx().raw.PATCH("/v1/sandboxes/{sandbox}", {
					params: { path: { sandbox: sb.id } },
					body: { labels },
				});
				ctx.out.result(data, (v) =>
					[
						`${v.slug} (${v.id})`,
						...Object.entries(v.labels).map(([k, x]) => `${k}=${x}`),
					].join("\n"),
				);
			}),
		);
}
