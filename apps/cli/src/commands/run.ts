// `sbx run [create flags] [--cwd] [--user] [--timeout] [--keep] -- <cmd...>`
// (S7 §14.2): create a sandbox, wait until it is ready, run the command
// with its output streamed like `exec`, then delete the sandbox (unless
// --keep, which makes it current). Exits with the command's code. Progress
// goes to stderr; stdout carries only the command's output (or its frames
// with --json). Ctrl-C at any point deletes the sandbox (unless --keep).
// `--push <dir>` (upload a directory first) comes with `sbx push`.

import type { Command } from "commander";
import { parseDuration } from "../args.ts";
import type { Context } from "../context.ts";
import { writeCurrent } from "../current.ts";
import { CliError, NOT_IMPLEMENTED } from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import { waitForState } from "../wait.ts";
import {
	addCreateOptions,
	type CreateFlags,
	createBody,
	createSandbox,
} from "./create.ts";
import {
	commandSpec,
	EXIT_INTERRUPTED,
	type ExecFlags,
	execIn,
	remoteCommand,
} from "./exec.ts";

interface RunFlags extends CreateFlags {
	cwd?: string;
	user?: string;
	timeout?: string;
	keep?: boolean;
	push?: string;
	waitTimeout?: string;
}

async function removeSandbox(ctx: Context, id: string): Promise<void> {
	try {
		await ctx.sbx().raw.DELETE("/v1/sandboxes/{sandbox}", {
			params: { path: { sandbox: id } },
			headers: { "Sbx-Confirm-Delete": id },
		});
	} catch (err) {
		ctx.out.warn(
			`could not delete ${id}: ${(err as Error).message}; run: sbx rm ${id} --yes`,
		);
	}
}

export function register(program: Command, run: Runner): void {
	addCreateOptions(
		program
			.command("run")
			.description(
				"create a sandbox, run a command in it, delete it: sbx run [flags] -- <cmd...>",
			)
			.argument("[cmd...]", "-- and the command"),
	)
		.option("--cwd <dir>", "working directory of the command")
		.option("--user <user>", "user to run the command as")
		.option(
			"--timeout <duration>",
			"kill the command after this long (exit 124)",
		)
		.option(
			"--wait-timeout <duration>",
			"limit of the wait for ready (default 5m)",
		)
		.option("--push <dir>", "upload this directory before the command")
		.option("--keep", "keep the sandbox (it becomes current)")
		.action(
			run(
				async (ctx, args, opts) => {
					const f = opts as RunFlags;
					const { cmd } = remoteCommand(ctx, (args[0] as string[]) ?? [], 0);
					if (f.push !== undefined) {
						throw new CliError({
							code: NOT_IMPLEMENTED,
							message: "run --push is not implemented yet",
							retryable: false,
						});
					}
					const exec: ExecFlags = {};
					if (f.cwd !== undefined) exec.cwd = f.cwd;
					if (f.user !== undefined) exec.user = f.user;
					if (f.timeout !== undefined) exec.timeout = f.timeout;
					commandSpec(exec); // flags checked before anything is created
					const timeoutMs =
						f.waitTimeout === undefined
							? undefined
							: parseDuration(f.waitTimeout, "--wait-timeout") * 1000;
					const body = createBody(f);
					// Ctrl-C at any point ends with the sandbox deleted (unless
					// --keep). While the command runs, exec's own forwarding has
					// it (first Ctrl-C to the command, second detaches); this
					// handler only keeps the process alive until the cleanup.
					const ac = new AbortController();
					let executing = false;
					const onInt = () => {
						if (!executing) ac.abort();
					};
					process.on("SIGINT", onInt);
					let id: string | undefined;
					let slug = "";
					try {
						// The create is not aborted: its answer names the sandbox to delete.
						const created = await createSandbox(ctx, body);
						id = created.sandbox.id;
						slug = created.sandbox.slug;
						ctx.out.info(`sbx: created ${slug} (${id})`);
						if (ac.signal.aborted) return EXIT_INTERRUPTED;
						try {
							await waitForState(ctx, created.sandbox, "ready", {
								...(timeoutMs === undefined ? {} : { timeoutMs }),
								signal: ac.signal,
								onState: (s) => ctx.out.info(`sbx: ${s.slug} is ${s.state}`),
							});
							const sb = await ctx
								.sbx()
								.sandboxes.get(id, { signal: ac.signal });
							executing = true;
							return await execIn(ctx, sb, cmd, exec, {
								detachHint: f.keep === true,
							});
						} catch (err) {
							if (ac.signal.aborted) return EXIT_INTERRUPTED;
							throw err;
						}
					} finally {
						if (id !== undefined) {
							if (f.keep === true) {
								writeCurrent(ctx, id);
								ctx.out.info(`sbx: kept ${slug} (${id})`);
							} else {
								await removeSandbox(ctx, id);
							}
						}
						process.off("SIGINT", onInt);
					}
				},
				{ rawData: true },
			),
		);
}
