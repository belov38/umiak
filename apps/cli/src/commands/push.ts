// `sbx push [dir] <sb>:<path>` (S7 §14.2): uploads a directory (default the
// working directory) into `<path>` as one tar.gz stream (PUT /files/archive,
// existing files overwritten, nothing deleted).
// - In a git work tree: the files of `git ls-files -co --exclude-standard`
//   (tracked and untracked, without ignored ones; deleted files skipped)
//   with their parent directories. Submodules come as empty directories.
// - Elsewhere: the whole directory.
// stdout stays empty; `--json` prints the ArchiveResult.

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ArchiveResult, Sandbox } from "@sbx/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import { localStat, parseRemote } from "./cp.ts";

/** The files git would commit from `dir` (relative), or null outside git. */
export function gitFiles(dir: string): string[] | null {
	const inside = spawnSync(
		"git",
		["-C", dir, "rev-parse", "--is-inside-work-tree"],
		{
			encoding: "utf8",
		},
	);
	if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
	const ls = spawnSync(
		"git",
		["-C", dir, "ls-files", "-z", "-c", "-o", "--exclude-standard"],
		{ encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
	);
	if (ls.status !== 0) {
		throw usageError(`git ls-files failed in ${dir}: ${ls.stderr.trim()}`);
	}
	return ls.stdout.split("\0").filter((f) => {
		if (f === "") return false;
		try {
			lstatSync(join(dir, f)); // a tracked file deleted from the work tree
			return true;
		} catch {
			return false;
		}
	});
}

/** Checks that `dir` is a local directory (usage error otherwise). */
export function checkPushDir(dir: string): void {
	if (localStat(dir)?.isDirectory() !== true) {
		throw usageError(`${dir} is not a directory`);
	}
}

/** Uploads `dir` into `path` of `sb` (see the header). */
export function pushDir(
	ctx: Context,
	sb: Sandbox,
	dir: string,
	path: string,
	signal?: AbortSignal,
): Promise<ArchiveResult> {
	const files = gitFiles(dir);
	return sb.files.uploadDir(dir, path, {
		retryBudgetMs: ctx.transferBudgetMs,
		...(signal === undefined ? {} : { signal }),
		...(files === null ? {} : { entries: files }),
	});
}

export function register(program: Command, run: Runner): void {
	program
		.command("push")
		.description(
			"upload a directory into a sandbox (git ls-files in a repository): sbx push [dir] <sb>:<path>",
		)
		.argument(
			"<dir-or-dest>",
			"local directory (default .), or the destination",
		)
		.argument("[dest]", "<sb>:<path>; :<path> is the current sandbox")
		.action(
			run(
				async (ctx, args) => {
					const [a, b] = args as [string, string | undefined];
					const [dir, dest] = b === undefined ? [".", a] : [a, b];
					const to = parseRemote(dest);
					if (to === null) {
						throw usageError(
							`the destination must be <sb>:<path>, not ${JSON.stringify(dest)}`,
						);
					}
					checkPushDir(dir);
					const sb = await useSandbox(ctx, to.sandbox);
					const r = await pushDir(ctx, sb, dir, to.path);
					if (ctx.out.jsonFlag) ctx.out.result(r);
					else if (ctx.interactive) {
						ctx.out.info(
							`sbx: pushed ${r.entries} entries (${r.sizeBytes} bytes) to ${sb.slug}:${r.path}`,
						);
					}
				},
				{ rawData: true },
			),
		);
}
