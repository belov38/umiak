// `sbx run [create flags] [--push dir] [--cwd] [--user] [--timeout] [--keep]
// -- <cmd...>` (S7 §14.2): create a sandbox, wait until it is ready, push
// `dir` (like `sbx push`) to `~/<name of dir>`, which becomes the command's
// working directory unless --cwd, run the command with its output streamed
// like `exec`, then delete the sandbox (unless --keep, which makes it
// current). Exits with the command's code. Progress goes to stderr; stdout
// carries only the command's output (or its frames with --json). Ctrl-C,
// SIGTERM or SIGHUP at any point deletes the sandbox (unless --keep).

import { basename, resolve } from "node:path";
import type { Command } from "commander";
import { parseDuration } from "../args.ts";
import type { Context } from "../context.ts";
import { writeCurrent } from "../current.ts";
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
	type ExecFlags,
	execIn,
	remoteCommand,
	STOP_SIGNALS,
	stopExitCode,
} from "./exec.ts";
import { checkPushDir, pushDir } from "./push.ts";

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
		.option(
			"--push <dir>",
			"upload this directory (like sbx push) to ~/<its name> and run the command there",
		)
		.option("--keep", "keep the sandbox (it becomes current)")
		.action(
			run(
				async (ctx, args, opts) => {
					const f = opts as RunFlags;
					const { cmd } = remoteCommand(ctx, (args[0] as string[]) ?? [], 0);
					// Checked before anything is created.
					if (f.push !== undefined) checkPushDir(f.push);
					const pushTo =
						f.push === undefined ? undefined : basename(resolve(f.push));
					const exec: ExecFlags = {};
					if (f.cwd !== undefined) exec.cwd = f.cwd;
					else if (pushTo !== undefined) exec.cwd = pushTo;
					if (f.user !== undefined) exec.user = f.user;
					if (f.timeout !== undefined) exec.timeout = f.timeout;
					commandSpec(exec); // flags checked before anything is created
					const timeoutMs =
						f.waitTimeout === undefined
							? undefined
							: parseDuration(f.waitTimeout, "--wait-timeout") * 1000;
					const body = createBody(f);
					// Ctrl-C, SIGTERM or SIGHUP at any point ends with the sandbox
					// deleted (unless --keep) and exit 130/143/129. While the
					// command runs, exec's own handlers have them (first Ctrl-C
					// to the command, second detaches); these only keep the
					// process alive until the cleanup.
					const ac = new AbortController();
					let executing = false;
					let stoppedBy: NodeJS.Signals | undefined;
					const onStop = (sig: NodeJS.Signals) => {
						if (executing) return;
						stoppedBy ??= sig;
						ac.abort();
					};
					const stops = ["SIGINT", ...STOP_SIGNALS] as const;
					for (const sig of stops) process.on(sig, onStop);
					const stopped = () => stopExitCode(stoppedBy);
					let id: string | undefined;
					let slug = "";
					try {
						// The create is not aborted: its answer names the sandbox to delete.
						const created = await createSandbox(ctx, body);
						id = created.sandbox.id;
						slug = created.sandbox.slug;
						ctx.out.info(`sbx: created ${slug} (${id})`);
						if (ac.signal.aborted) return stopped();
						try {
							await waitForState(ctx, created.sandbox, "ready", {
								...(timeoutMs === undefined ? {} : { timeoutMs }),
								signal: ac.signal,
								onState: (s) => ctx.out.info(`sbx: ${s.slug} is ${s.state}`),
							});
							const sb = await ctx
								.sbx()
								.sandboxes.get(id, { signal: ac.signal });
							if (f.push !== undefined && pushTo !== undefined) {
								const r = await pushDir(ctx, sb, f.push, pushTo, ac.signal);
								ctx.out.info(
									`sbx: pushed ${r.entries} entries to ${slug}:${r.path}`,
								);
							}
							executing = true;
							return await execIn(ctx, sb, cmd, exec, {
								detachHint: f.keep === true,
							});
						} catch (err) {
							if (ac.signal.aborted) return stopped();
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
						for (const sig of stops) process.off(sig, onStop);
					}
				},
				{ rawData: true },
			),
		);
}
