// `umiak rm <sb>... [--yes]` (S7 §5.12, §14.2): deletes sandboxes (a running
// one too). Asks in a terminal; without one --yes is required (exit 2
// otherwise, nothing deleted). Each DELETE carries `Umiak-Confirm-Delete`
// with the sandbox id read before. Prints the answer `{sandbox, operation}`
// (an array of them for several sandboxes, one JSON document either way);
// a deleted current sandbox is forgotten.

import type { Sandbox } from "@umiak/sdk";
import type { Command } from "commander";
import { confirm } from "../confirm.ts";
import { clearCurrent, readCurrent } from "../current.ts";
import { sandboxLine } from "../format.ts";
import type { Runner } from "../program.ts";

export function register(program: Command, run: Runner): void {
	program
		.command("rm")
		.description("delete sandboxes")
		.argument("<sb...>", "sandbox IDs or slugs")
		.option("-y, --yes", "do not ask (required without a terminal)")
		.action(
			run(async (ctx, args, opts) => {
				const refs = args[0] as string[];
				const yes = opts.yes === true;
				if (!yes && !ctx.interactive) {
					// Before any request: nothing is read or deleted.
					await confirm(ctx, false, "");
				}
				const sbs: Sandbox[] = [];
				for (const ref of refs) sbs.push(await ctx.umiak().sandboxes.get(ref));
				const names = sbs.map((s) => `${s.slug} (${s.id})`).join(", ");
				await confirm(
					ctx,
					yes,
					sbs.length === 1
						? `Delete sandbox ${names}?`
						: `Delete ${sbs.length} sandboxes: ${names}?`,
				);
				const current = readCurrent(ctx);
				let first: unknown;
				const answers: { sandbox: Sandbox["data"] }[] = [];
				for (const sb of sbs) {
					try {
						const { data } = await ctx
							.umiak()
							.raw.DELETE("/v1/sandboxes/{sandbox}", {
								params: { path: { sandbox: sb.id } },
								headers: { "Umiak-Confirm-Delete": sb.id },
							});
						if (current === sb.id) clearCurrent(ctx);
						answers.push(data as { sandbox: Sandbox["data"] });
					} catch (err) {
						first ??= err;
						if (sbs.length > 1) {
							ctx.out.warn(`${sb.slug}: ${(err as Error).message}`);
						}
					}
				}
				const line = (v: { sandbox: Sandbox["data"] }) =>
					`Deleting ${sandboxLine(v.sandbox)}`;
				// One JSON document: the answer of one sandbox, an array for several.
				if (refs.length === 1) {
					if (answers[0] !== undefined) ctx.out.result(answers[0], line);
				} else if (answers.length > 0 || first === undefined) {
					ctx.out.result(answers, (list) => list.map(line).join("\n"));
				}
				if (first !== undefined) throw first;
			}),
		);
}
