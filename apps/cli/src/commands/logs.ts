// `sbx logs [<sb>] <cmd> [-f] [--tail <bytes>]` (S7 §9.4, §14.2): the output
// of a command, raw (stdout to stdout, stderr to stderr) or with --json the
// frames with `event`. Without -f it prints what there is now and exits;
// with -f it follows until the command exits. --tail starts each stream at
// its last N bytes. Exit code 0 (not the command's).

import type {
	Offsets,
	OutputStream,
	RunEvent,
	Command as SbxCommand,
} from "@sbx/sdk";
import type { Command } from "commander";
import { parseCount } from "../args.ts";
import { useSandbox } from "../current.ts";
import type { Runner } from "../program.ts";
import { printEvents } from "./exec.ts";

const RUNNING = new Set(["starting", "running"]);

/** The events until the offsets reach `sizes` (what existed when asked). */
async function* upTo<E extends RunEvent<"base64"> | RunEvent<"utf8">>(
	events: AsyncIterable<E>,
	start: Offsets,
	sizes: Partial<Record<OutputStream, number>>,
): AsyncGenerator<E> {
	const at: Partial<Record<OutputStream, number>> = {
		stdout: start.stdoutOffset,
		stderr: start.stderrOffset,
		...(start.ptyOffset === undefined ? {} : { pty: start.ptyOffset }),
	};
	const caughtUp = () =>
		Object.entries(sizes).every(
			([s, n]) => (at[s as OutputStream] ?? 0) >= (n ?? 0),
		);
	if (caughtUp()) return;
	for await (const ev of events) {
		yield ev;
		if (ev.type === "exit") return;
		if (ev.type === "truncated") at[ev.stream] = ev.availableFrom;
		else at[ev.type] = ev.nextOffset;
		if (caughtUp()) return;
	}
}

export function register(program: Command, run: Runner): void {
	program
		.command("logs")
		.description("print the output of a command")
		.argument(
			"<sb-or-cmd>",
			"sandbox ID or slug, or the command (current sandbox)",
		)
		.argument("[cmd]", "command ID (cmd_…)")
		.option("-f, --follow", "follow the output until the command exits")
		.option("--tail <bytes>", "start each stream at its last N bytes")
		.action(
			run(
				async (ctx, args, opts) => {
					const [a, b] = args as [string, string | undefined];
					const sb = await useSandbox(ctx, b === undefined ? undefined : a);
					const cmd: SbxCommand = sb.command(b ?? a);
					const data = await cmd.refresh();
					const streams = data.streams ?? {};
					const size = (s: OutputStream) => streams[s]?.sizeBytes ?? 0;
					const tail =
						opts.tail === undefined
							? undefined
							: parseCount(opts.tail as string, "--tail");
					const from: Offsets =
						tail === undefined
							? { stdoutOffset: 0, stderrOffset: 0 }
							: {
									stdoutOffset: Math.max(0, size("stdout") - tail),
									stderrOffset: Math.max(0, size("stderr") - tail),
									...(streams.pty
										? { ptyOffset: Math.max(0, size("pty") - tail) }
										: {}),
								};
					if (tail === undefined && streams.pty) from.ptyOffset = 0;
					const json = ctx.out.explicitJson;
					const events = cmd.follow({
						from,
						encoding: json ? "utf8" : "base64",
					});
					const follow = opts.follow === true || !RUNNING.has(data.status);
					const sizes: Partial<Record<OutputStream, number>> = {
						stdout: size("stdout"),
						stderr: size("stderr"),
						...(streams.pty ? { pty: size("pty") } : {}),
					};
					await printEvents(
						ctx,
						follow ? events : upTo(events, from, sizes),
						json,
					);
				},
				{ rawData: true },
			),
		);
}
