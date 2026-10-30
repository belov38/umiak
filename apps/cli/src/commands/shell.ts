// `sbx shell [<sb>] [--attach <cmd>] [-- <cmd...>]` (S7 §10, §14.2): a
// terminal in the sandbox over the PTY WebSocket.
// - The command after `--` is a shell line (several words are joined with
//   shell quoting); without one, the user's login shell.
// - A terminal on stdin goes to raw mode (keys, Ctrl-C included, go to the
//   sandbox) and is restored at the end; its size is sent at start and on
//   SIGWINCH. Without a terminal, COLUMNS/LINES give the size, and the end
//   of stdin sends ^D (EOF on the remote terminal).
// - The SDK reconnects by offset after a drop (input typed meanwhile is
//   queued up to 1 MiB; past that, stdin pauses until it drains). If the SDK
//   gives up, sbx attaches again with 64 KiB of scrollback (up to
//   REATTACH_ROUNDS times). `--attach cmd_…` joins a running terminal the
//   same way (the agent keeps one 10 min without a client).
// - sbx exits with the terminal command's code (128+n for a signal). A
//   SIGINT to sbx itself (no raw terminal) leaves the terminal running and
//   exits 130.

import type { Pty, Sandbox } from "@sbx/sdk";
import { SbxError } from "@sbx/sdk";
import type { Command } from "commander";
import { splitDashDash } from "../args.ts";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { commandExitCode, usageError } from "../exit-codes.ts";
import { OutputClosedError } from "../output.ts";
import type { Runner } from "../program.ts";
import { EXIT_INTERRUPTED } from "./exec.ts";

/** Scrollback of a new attach (S7 §10.2: the CLI's tailBytes). */
export const SCROLLBACK_BYTES = 64 * 1024;
/** New attaches after the SDK's own reconnects gave up. */
const REATTACH_ROUNDS = 3;
/** Wait before writing input again after `pty_input_overflow`. */
const OVERFLOW_RETRY_MS = 100;

/** POSIX shell quoting of one word. */
function shellQuote(w: string): string {
	return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`;
}

interface TerminalSize {
	cols: number;
	rows: number;
}

/** The size of this terminal, or COLUMNS/LINES without one. */
function terminalSize(ctx: Context): TerminalSize | undefined {
	const out = process.stdout;
	if (out.isTTY && out.columns > 0 && out.rows > 0) {
		return { cols: out.columns, rows: out.rows };
	}
	const cols = Number(ctx.env.COLUMNS);
	const rows = Number(ctx.env.LINES);
	if (
		Number.isInteger(cols) &&
		cols > 0 &&
		Number.isInteger(rows) &&
		rows > 0
	) {
		return { cols: Math.min(cols, 1000), rows: Math.min(rows, 1000) };
	}
	return undefined;
}

/**
 * Feeds stdin into the current Pty. On `pty_input_overflow` stdin is paused
 * and the chunk written again later.
 */
function pumpInput(
	ctx: Context,
	current: () => Pty,
	onEnd: () => void,
): () => void {
	const stdin = ctx.stdin as NodeJS.ReadStream;
	let pending: Uint8Array | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const send = (b: Uint8Array): boolean => {
		try {
			current().write(b);
			return true;
		} catch (err) {
			if (err instanceof SbxError && err.code === "pty_input_overflow") {
				return false;
			}
			throw err;
		}
	};
	const retry = () => {
		timer = undefined;
		if (pending === null) return;
		if (send(pending)) {
			pending = null;
			stdin.resume();
		} else {
			timer = setTimeout(retry, OVERFLOW_RETRY_MS);
		}
	};
	const onData = (chunk: Buffer | string) => {
		const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		if (pending !== null || !send(new Uint8Array(b))) {
			pending = pending === null ? new Uint8Array(b) : concat(pending, b);
			stdin.pause();
			timer ??= setTimeout(retry, OVERFLOW_RETRY_MS);
		}
	};
	stdin.on("data", onData);
	stdin.once("end", onEnd);
	stdin.resume();
	return () => {
		clearTimeout(timer);
		stdin.off("data", onData);
		stdin.off("end", onEnd);
		stdin.pause();
	};
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
}

async function runShell(
	ctx: Context,
	sb: Sandbox,
	o: { command: string | null; attach?: string },
): Promise<number> {
	const size = terminalSize(ctx);
	const term =
		ctx.env.TERM && ctx.env.TERM !== "dumb" ? ctx.env.TERM : "xterm-256color";
	let pty =
		o.attach === undefined
			? await sb.pty({ ...size, command: o.command, term })
			: await sb.connectPty(o.attach, { tailBytes: SCROLLBACK_BYTES });
	const stdin = ctx.stdin as NodeJS.ReadStream;
	const raw = stdin.isTTY === true && typeof stdin.setRawMode === "function";
	let closed = false;
	const onOutput = (b: Uint8Array) => {
		ctx.out.data(b).catch((err: unknown) => {
			// The reader of stdout left: stop following (the terminal stays).
			if (err instanceof OutputClosedError && !closed) {
				closed = true;
				pty.close();
			}
		});
	};
	let unsubscribe = pty.onData(onOutput);
	const onWinch = () => {
		const s = terminalSize(ctx);
		if (s !== undefined) pty.resize(s.cols, s.rows);
	};
	let interrupted = false;
	const onInt = () => {
		interrupted = true;
		pty.close();
	};
	if (o.attach !== undefined && size !== undefined) {
		pty.resize(size.cols, size.rows);
	}
	if (raw) stdin.setRawMode(true);
	process.on("SIGWINCH", onWinch);
	process.on("SIGINT", onInt);
	const stopInput = pumpInput(
		ctx,
		() => pty,
		() => {
			// End of a piped stdin: EOF for the remote terminal.
			if (!raw) {
				try {
					pty.write("\x04");
				} catch {
					// Reconnecting with a full queue: the terminal ends by itself.
				}
			}
		},
	);
	try {
		for (let round = 0; ; round++) {
			try {
				const exit = await pty.exited;
				return commandExitCode(exit);
			} catch (err) {
				if (interrupted) {
					ctx.out.info(
						`sbx: the terminal keeps running; attach again: sbx shell ${sb.slug} --attach ${pty.command.id}`,
					);
					return EXIT_INTERRUPTED;
				}
				if (closed) throw new OutputClosedError();
				if (
					!(err instanceof SbxError) ||
					!err.retryable ||
					round >= REATTACH_ROUNDS
				) {
					throw err;
				}
				unsubscribe();
				pty = await sb.connectPty(pty.command.id, {
					tailBytes: SCROLLBACK_BYTES,
				});
				unsubscribe = pty.onData(onOutput);
				onWinch();
			}
		}
	} finally {
		stopInput();
		process.off("SIGWINCH", onWinch);
		process.off("SIGINT", onInt);
		if (raw) stdin.setRawMode(false);
		unsubscribe();
		(stdin as { destroy?: () => void }).destroy?.();
	}
}

export function register(program: Command, run: Runner): void {
	program
		.command("shell")
		.description("open a terminal in a sandbox: sbx shell [<sb>] [-- <cmd...>]")
		.argument("[args...]", "sandbox ID or slug, then -- and a command")
		.option(
			"--attach <cmd>",
			"join a running terminal (cmd_…) with 64 KiB of scrollback",
		)
		.action(
			run(
				async (ctx, args, opts) => {
					const { before, after } = splitDashDash(
						ctx.argv,
						(args[0] as string[]) ?? [],
					);
					if (before.length > 1) {
						throw usageError(
							`unexpected ${JSON.stringify(before[1])}: put the command after --`,
						);
					}
					const attach = opts.attach as string | undefined;
					if (attach !== undefined && after !== null && after.length > 0) {
						throw usageError("--attach joins a terminal; drop the command");
					}
					const command =
						after === null || after.length === 0
							? null
							: after.length === 1
								? (after[0] as string)
								: after.map(shellQuote).join(" ");
					const sb = await useSandbox(ctx, before[0]);
					return runShell(ctx, sb, {
						command,
						...(attach === undefined ? {} : { attach }),
					});
				},
				{ rawData: true },
			),
		);
}
