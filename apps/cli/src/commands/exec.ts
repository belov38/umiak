// `sbx exec [<sb>] [flags] -- <cmd...>` (S7 §9, §14.2, §14.3).
// - The remote command follows `--`: one word is a shell line (`bash -lc`),
//   several are argv (no shell).
// - Default: the output streams live, stdout to stdout and stderr to stderr
//   as raw bytes (encoding base64 on the wire), with the SDK's automatic
//   reattach; `sbx` exits with the command's code (128+n for a signal, 124
//   timed out, 125 lost or failed to start).
// - `--json` (explicit): the API frames as NDJSON with `event` instead of
//   `type` (`started`, `stdout`, `stderr`, `truncated`, `exit`).
// - `--detach`: starts the command and prints its id (the Command resource
//   with --json).
// - `--stdin`: the command is started with stdin open and this process's
//   stdin is sent to it; EOF closes it.
// - Ctrl-C sends SIGINT to the remote command; a second Ctrl-C leaves it
//   running and exits 130.
// - When the reader of stdout goes away (`sbx exec … | head -1`), the remote
//   command is killed (SIGTERM, then SIGKILL after the api's grace), as a
//   local pipeline's writer dies of SIGPIPE, and sbx exits 141 quietly.

import { randomUUID } from "node:crypto";
import {
	type ExitEvent,
	newIdempotencyKey,
	type RunEvent,
	type Sandbox,
	type Command as SbxCommand,
} from "@sbx/sdk";
import type { Command } from "commander";
import { collect, parseDuration, parsePairs, splitDashDash } from "../args.ts";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { CliError, commandExitCode, usageError } from "../exit-codes.ts";
import { OutputClosedError } from "../output.ts";
import type { Runner } from "../program.ts";

/** Exit code after a second Ctrl-C (the remote command keeps running). */
export const EXIT_INTERRUPTED = 130;
/** Bytes of stdin per input request. */
const STDIN_CHUNK = 256 * 1024;

export interface ExecFlags {
	cwd?: string;
	env?: string[];
	user?: string;
	timeout?: string;
	tag?: string[];
}

/** The command spec of the flags (POST /commands without command/mode). */
export function commandSpec(f: ExecFlags) {
	const spec: {
		cwd?: string;
		env?: Record<string, string>;
		user?: string;
		timeoutSeconds?: number;
		tags?: Record<string, string>;
	} = {};
	if (f.cwd !== undefined) spec.cwd = f.cwd;
	if (f.env !== undefined) spec.env = parsePairs(f.env, "--env");
	if (f.user !== undefined) spec.user = f.user;
	if (f.timeout !== undefined) {
		spec.timeoutSeconds = parseDuration(f.timeout, "--timeout");
	}
	if (f.tag !== undefined) spec.tags = parsePairs(f.tag, "--tag");
	return spec;
}

/** The options of exec (also run). */
export function addExecOptions(c: Command): Command {
	return c
		.option("--cwd <dir>", "working directory (default: the user's home)")
		.option("--env <K=V>", "env variable of this command (repeatable)", collect)
		.option("--user <user>", "user to run as (default: user; root allowed)")
		.option(
			"--timeout <duration>",
			"kill the command after this long (exit 124)",
		)
		.option("--tag <k=v>", "tag of the command (repeatable)", collect);
}

/** The remote command after `--`: one word is a shell line, more are argv. */
export function remoteCommand(
	ctx: Context,
	operands: string[],
	maxBefore: number,
): { before: string[]; cmd: string | string[] } {
	const { before, after } = splitDashDash(ctx.argv, operands);
	if (after === null || after.length === 0) {
		throw usageError("put the command after --, e.g. sbx exec <sb> -- ls -la");
	}
	if (before.length > maxBefore) {
		throw usageError(
			`unexpected ${JSON.stringify(before[maxBefore])}: put the command after --`,
		);
	}
	return { before, cmd: after.length === 1 ? (after[0] as string) : after };
}

/**
 * Prints command events: raw bytes (stdout, stderr), or with `json` the
 * frames with `event`. Returns the exit event, if one came.
 */
export async function printEvents(
	ctx: Context,
	events: AsyncIterable<RunEvent<"base64"> | RunEvent<"utf8">>,
	json: boolean,
): Promise<ExitEvent | undefined> {
	for await (const ev of events) {
		if (json) {
			const { type, ...rest } = ev;
			await ctx.out.event(type, rest);
			ctx.out.throwIfClosed();
			if (ev.type === "exit") return ev;
			continue;
		}
		switch (ev.type) {
			case "stdout":
			case "pty":
				await ctx.out.data(ev.data);
				break;
			case "stderr":
				await ctx.out.errData(ev.data);
				break;
			case "truncated":
				ctx.out.warn(
					`${ev.stream} before byte ${ev.availableFrom} is no longer kept by the sandbox`,
				);
				break;
			case "exit":
				return ev;
		}
	}
	return undefined;
}

/**
 * Ctrl-C forwarding while a command streams: the first SIGINT signals the
 * remote command, the second aborts (`signal`). Call `stop()` at the end.
 */
export function forwardInterrupts(
	ctx: Context,
	current: () => SbxCommand | undefined,
): { signal: AbortSignal; interrupted: () => boolean; stop(): void } {
	const ac = new AbortController();
	let count = 0;
	const onInt = () => {
		count++;
		const cmd = current();
		if (count === 1 && cmd !== undefined) {
			ctx.out.info(
				"sbx: sending SIGINT to the command (Ctrl-C again to detach)",
			);
			cmd.signal("SIGINT").catch(() => {});
			return;
		}
		ac.abort();
	};
	process.on("SIGINT", onInt);
	return {
		signal: ac.signal,
		interrupted: () => ac.signal.aborted,
		stop: () => process.off("SIGINT", onInt),
	};
}

/**
 * Runs `cmd` in `sb`, printing its output; returns sbx's exit code.
 * `detachHint`: after a second Ctrl-C, tell how to find the command again
 * (false when the sandbox is about to be deleted, `run`).
 */
export async function execIn(
	ctx: Context,
	sb: Sandbox,
	cmd: string | string[],
	f: ExecFlags & { stdin?: boolean },
	o: { detachHint?: boolean } = {},
): Promise<number> {
	const json = ctx.out.jsonFlag;
	const encoding = json ? "utf8" : "base64";
	const spec = commandSpec(f);
	let command: SbxCommand | undefined;
	const onStart = (c: SbxCommand) => {
		command = c;
		if (json) void ctx.out.event("started", { commandId: c.id });
	};
	const fwd = forwardInterrupts(ctx, () => command);
	// True while this process's stdin is being sent (--stdin).
	let pumping = false;
	try {
		let exit: ExitEvent | undefined;
		if (f.stdin === true) {
			const c = await sb.start(cmd, {
				...spec,
				stdin: true,
				signal: fwd.signal,
				idempotencyKey: newIdempotencyKey(),
			});
			onStart(c);
			// The command may exit before stdin ends (it never reads it):
			// then the rest of stdin is dropped, not waited for.
			pumping = true;
			let pumpError: unknown;
			pumpStdin(ctx, c, fwd.signal).then(
				() => {
					pumping = false;
				},
				(err: unknown) => {
					pumping = false;
					pumpError = err;
				},
			);
			exit = await printEvents(
				ctx,
				c.follow({ from: "start", encoding, signal: fwd.signal }),
				json,
			);
			if (!pumping && pumpError !== undefined) {
				ctx.out.warn(
					`stdin was not delivered: ${(pumpError as Error).message}`,
				);
			}
		} else {
			exit = await printEvents(
				ctx,
				sb.run(cmd, { ...spec, encoding, onStart, signal: fwd.signal }),
				json,
			);
		}
		if (exit === undefined) {
			throw new CliError({
				code: "unexpected_response",
				message: "the command stream ended without an exit",
				retryable: false,
			});
		}
		return commandExitCode(exit);
	} catch (err) {
		if (err instanceof OutputClosedError && command !== undefined) {
			// Best effort: the reader is gone, the output has nowhere to go.
			await command
				.kill({ signal: AbortSignal.timeout(5_000), retryBudgetMs: 2_000 })
				.catch(() => {});
		}
		if (fwd.interrupted()) {
			if (command !== undefined && o.detachHint !== false) {
				ctx.out.info(
					`sbx: ${command.id} keeps running; see: sbx logs ${command.id}`,
				);
			}
			return EXIT_INTERRUPTED;
		}
		throw err;
	} finally {
		fwd.stop();
		// The command ended, failed or was left: the rest of stdin is dropped.
		if (pumping) (ctx.stdin as { destroy?: () => void }).destroy?.();
	}
}

/** Sends this process's stdin to the command, then closes its stdin. */
async function pumpStdin(
	ctx: Context,
	c: SbxCommand,
	signal: AbortSignal,
): Promise<void> {
	const sessionId = randomUUID();
	let seq = 0;
	for await (const chunk of ctx.stdin) {
		const buf =
			typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
		for (let i = 0; i < buf.length; i += STDIN_CHUNK) {
			await c.input(new Uint8Array(buf.subarray(i, i + STDIN_CHUNK)), {
				sessionId,
				seq: seq++,
				signal,
			});
		}
	}
	await c.input("", { closeStdin: true, sessionId, seq: seq++, signal });
}

export function register(program: Command, run: Runner): void {
	addExecOptions(
		program
			.command("exec")
			.description(
				"run a command in a sandbox: sbx exec [<sb>] [flags] -- <cmd...>",
			)
			.argument("[args...]", "sandbox ID or slug, then -- and the command")
			.addHelpText(
				"after",
				[
					"",
					"The command after --:",
					"  one word runs as a shell line (bash -lc):  sbx exec sb -- 'npm test && ls'",
					"  several words run as argv, without a shell: sbx exec sb -- ls -la /tmp",
					"stdout and stderr are the command's own bytes; sbx exits with its code",
					"(128+n for a signal, 124 timed out, 125 lost). --json prints NDJSON frames.",
				].join("\n"),
			),
	)
		.option("--detach", "start the command and print its id")
		.option("--stdin", "send this process's stdin to the command")
		.action(
			run(
				async (ctx, args, opts) => {
					const f = opts as ExecFlags & { detach?: boolean; stdin?: boolean };
					const { before, cmd } = remoteCommand(
						ctx,
						(args[0] as string[]) ?? [],
						1,
					);
					// Every flag is checked before a request or a new current sandbox.
					if (f.detach === true && f.stdin === true) {
						throw usageError(
							"--stdin needs the command attached; drop --detach",
						);
					}
					const spec = commandSpec(f);
					const sb = await useSandbox(ctx, before[0]);
					if (f.detach === true) {
						const c = await sb.start(cmd, spec);
						if (ctx.out.jsonFlag) ctx.out.result(c.data);
						else await ctx.out.data(`${c.id}\n`);
						return;
					}
					return execIn(ctx, sb, cmd, f);
				},
				{ rawData: true },
			),
		);
}
