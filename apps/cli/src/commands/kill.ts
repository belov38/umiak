// `umiak kill [<sb>] <cmd> [--signal SIG] [--grace <duration>]` (S7 §9.4):
// SIGTERM then SIGKILL after the grace (default 10 s), or one signal with
// --signal. Prints the Command resource.

import type { Command } from "commander";
import { parseDuration } from "../args.ts";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

const SIGNALS = [
	"SIGINT",
	"SIGTERM",
	"SIGKILL",
	"SIGHUP",
	"SIGUSR1",
	"SIGUSR2",
	"SIGQUIT",
] as const;
type Signal = (typeof SIGNALS)[number];

function parseSignal(v: string): Signal {
	const name = (
		v.toUpperCase().startsWith("SIG") ? v : `SIG${v}`
	).toUpperCase();
	if (!(SIGNALS as readonly string[]).includes(name)) {
		throw usageError(
			`--signal takes one of ${SIGNALS.join(", ")}, not ${JSON.stringify(v)}`,
		);
	}
	return name as Signal;
}

export function register(program: Command, run: Runner): void {
	program
		.command("kill")
		.description("stop a command")
		.argument(
			"<sb-or-cmd>",
			"sandbox ID or slug, or the command (current sandbox)",
		)
		.argument("[cmd]", "command ID (cmd_…)")
		.option(
			"--signal <sig>",
			"send this signal only: INT, TERM, KILL, HUP, USR1, USR2, QUIT",
		)
		.option(
			"--grace <duration>",
			"SIGKILL this long after SIGTERM (default 10s)",
		)
		.action(
			run(async (ctx, args, opts) => {
				const [a, b] = args as [string, string | undefined];
				const sb = await useSandbox(ctx, b === undefined ? undefined : a);
				const cmd = sb.command(b ?? a);
				const signal = opts.signal as string | undefined;
				const grace = opts.grace as string | undefined;
				if (signal !== undefined && grace !== undefined) {
					throw usageError("pass either --signal or --grace");
				}
				const data =
					signal !== undefined
						? await cmd.signal(parseSignal(signal))
						: await cmd.kill(
								grace === undefined
									? {}
									: { graceMs: parseDuration(grace, "--grace") * 1000 },
							);
				ctx.out.result(data, (v) => `${v.id}: ${v.status}`);
			}),
		);
}
