// `sbx push [dir] <sb>:<path>` (S7 §14.2): uploads a directory (default the
// working directory) into `<path>` as one tar.gz stream (PUT /files/archive,
// existing files overwritten, nothing deleted).
// - In a git work tree: the files of `git ls-files -co --exclude-standard`
//   (tracked and untracked, without ignored ones; deleted files skipped)
//   with their parent directories, names as git's bytes. Submodules come as
//   empty directories. If git lists nothing for a non-empty directory (it is
//   ignored), the whole directory goes, with a warning.
// - Elsewhere: the whole directory.
// stdout stays empty; `--json` prints the ArchiveResult.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import type { ArchiveResult, Sandbox } from "@sbx/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";
import { localStat, parseRemote } from "./cp.ts";

/**
 * The files git would commit from `dir` (relative, as the bytes git prints:
 * names need not be UTF-8), or null outside git.
 */
export function gitFiles(dir: string): Buffer[] | null {
	const inside = spawnSync(
		"git",
		["-C", dir, "rev-parse", "--is-inside-work-tree"],
		{ encoding: "utf8" },
	);
	if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
	const ls = spawnSync(
		"git",
		["-C", dir, "ls-files", "-z", "-c", "-o", "--exclude-standard"],
		{ maxBuffer: 1024 * 1024 * 1024 },
	);
	if (ls.status !== 0) {
		throw usageError(
			`git ls-files failed in ${dir}: ${ls.stderr.toString().trim()}`,
		);
	}
	const base = Buffer.from(`${dir}/`);
	const files: Buffer[] = [];
	let start = 0;
	for (let i = ls.stdout.indexOf(0); i >= 0; i = ls.stdout.indexOf(0, start)) {
		const name = ls.stdout.subarray(start, i);
		start = i + 1;
		try {
			lstatSync(Buffer.concat([base, name])); // deleted from the work tree?
			files.push(name);
		} catch {
			// A tracked file deleted from the work tree.
		}
	}
	return files;
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
	let files = gitFiles(dir);
	if (files !== null && files.length === 0 && readdirSync(dir).length > 0) {
		// An ignored directory (or only ignored files): git lists nothing.
		ctx.out.warn(
			`git lists no files in ${dir} (ignored?); pushing the whole directory`,
		);
		files = null;
	}
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
