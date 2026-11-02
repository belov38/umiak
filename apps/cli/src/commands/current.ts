// `umiak current [<sb> | --clear]` (S7 §14.2): prints `{sandbox}` (the
// resource) of this shell's current sandbox, or exits 3 when there is none
// or it was deleted. With <sb>, makes it current; --clear forgets it.

import { UmiakError } from "@umiak/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { clearCurrent, readCurrent, useSandbox } from "../current.ts";
import { CliError, NO_CURRENT_SANDBOX, usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

function noCurrent(why: string): CliError {
	return new CliError({
		code: NO_CURRENT_SANDBOX,
		message: `${why}; pick one with: umiak current <sb>`,
		retryable: false,
	});
}

async function current(
	ctx: Context,
	arg: string | undefined,
	clear: boolean,
): Promise<void> {
	if (clear) {
		if (arg !== undefined) throw usageError("pass either <sb> or --clear");
		clearCurrent(ctx);
		ctx.out.result({ sandbox: null }, () => "No current sandbox.");
		return;
	}
	if (arg !== undefined) {
		const sb = await useSandbox(ctx, arg);
		ctx.out.result(
			{ sandbox: sb.data },
			(v) => `Current sandbox: ${v.sandbox.slug} (${v.sandbox.id})`,
		);
		return;
	}
	const id = readCurrent(ctx);
	if (id === null) throw noCurrent("no current sandbox in this shell");
	let sb: Awaited<ReturnType<typeof useSandbox>>;
	try {
		sb = await ctx.umiak().sandboxes.get(id);
	} catch (err) {
		if (err instanceof UmiakError && err.status === 404) {
			clearCurrent(ctx);
			throw noCurrent(`the current sandbox ${id} no longer exists`);
		}
		throw err;
	}
	if (sb.state === "deleted") {
		clearCurrent(ctx);
		throw noCurrent(`the current sandbox ${sb.slug} was deleted`);
	}
	ctx.out.result(
		{ sandbox: sb.data },
		(v) => `${v.sandbox.slug} (${v.sandbox.id}): ${v.sandbox.state}`,
	);
}

export function register(program: Command, run: Runner): void {
	program
		.command("current")
		.description(
			"print the current sandbox of this shell; with <sb>, make it current",
		)
		.argument("[sb]", "sandbox ID or slug")
		.option("--clear", "forget the current sandbox")
		.action(
			run(async (ctx, args, opts) => {
				await current(ctx, args[0] as string | undefined, opts.clear === true);
			}),
		);
}
