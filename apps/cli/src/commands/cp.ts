// `umiak cp [-r] <src> <dst>` (S7 §11.1, §14.2): copies between this machine
// and a sandbox; `<sb>:<path>` names the sandbox side (exactly one side).
// - `<sb>` is an ID or slug; an empty one (`:path`) is the current sandbox.
//   A word before `:` that holds `/`, `\` or `.`, or is one letter (a
//   Windows drive), is a local path: write `./a:b` for a local file `a:b`.
// - Remote paths are absolute or relative to the user's home.
// - Upload: up to 64 MiB in one atomic PUT; larger files (and stdin, `-`)
//   in resumable 4 MiB chunks. The file's permission bits go with it.
// - Download: streamed, resumed with Range after a break; `-` is stdout.
// - A destination that is a directory (or ends with `/`) gets the source's
//   name inside it, like cp.
// - `-r`: a directory goes as one tar.gz (PUT/GET /files/archive); an
//   existing destination directory gets it inside, else it becomes the copy.
// stdout carries data only (`-`); `--json` prints the result (FileInfo,
// ArchiveResult or the local file) instead.

import { statSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { Readable } from "node:stream";
import { type Sandbox, UmiakError } from "@umiak/sdk";
import type { Command } from "commander";
import type { Context } from "../context.ts";
import { useSandbox } from "../current.ts";
import { usageError } from "../exit-codes.ts";
import type { Runner } from "../program.ts";

/** Files above this size go in resumable chunks (S7 §11.1). */
export const CHUNKED_ABOVE_BYTES = 64 * 1024 * 1024;

export interface RemoteSpec {
	/** ID or slug; undefined: the current sandbox. */
	sandbox: string | undefined;
	/** Path in the sandbox; "." for the home directory. */
	path: string;
}

/** `<sb>:<path>` as a RemoteSpec, or null for a local path. */
export function parseRemote(arg: string): RemoteSpec | null {
	const m = /^([^:/\\.]*):(.*)$/s.exec(arg);
	if (m === null) return null;
	const sb = m[1] as string;
	if (sb.length === 1) return null; // C:\path
	return {
		sandbox: sb === "" ? undefined : sb,
		path: m[2] === "" ? "." : (m[2] as string),
	};
}

/** The stat of a remote path, or null when there is none. */
export async function remoteStat(sb: Sandbox, path: string) {
	try {
		return await sb.files.stat(path);
	} catch (err) {
		if (err instanceof UmiakError && err.status === 404) return null;
		throw err;
	}
}

export function localStat(path: string) {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

interface CpFlags {
	recursive?: boolean;
}

async function upload(
	ctx: Context,
	src: string,
	dst: RemoteSpec,
	f: CpFlags,
): Promise<unknown> {
	const st = src === "-" ? null : localStat(src);
	if (src !== "-" && st === null) throw usageError(`${src}: no such file`);
	const sb = await useSandbox(ctx, dst.sandbox);
	const call = { retryBudgetMs: ctx.transferBudgetMs };
	const target = await remoteTarget(sb, dst.path, src === "-" ? null : src);
	if (st?.isDirectory()) {
		if (f.recursive !== true) {
			throw usageError(`${src} is a directory; use cp -r`);
		}
		return sb.files.uploadDir(src, target, call);
	}
	if (src === "-") {
		return sb.files.upload(
			target,
			Readable.toWeb(ctx.stdin as Readable) as ReadableStream<Uint8Array>,
			call,
		);
	}
	const mode = (st?.mode ?? 0o644) & 0o777;
	if ((st?.size ?? 0) > CHUNKED_ABOVE_BYTES) {
		return sb.files.upload(target, src, { ...call, mode });
	}
	return sb.files.writeBytes(target, await readFile(src), { ...call, mode });
}

/**
 * Where a copy of local `src` goes: inside `path` when that is a directory
 * (or ends with `/`), else `path` itself.
 */
async function remoteTarget(
	sb: Sandbox,
	path: string,
	src: string | null,
): Promise<string> {
	const name = src === null ? null : basename(src);
	if (path.endsWith("/") || path === ".") {
		if (name === null) throw usageError(`name the file: ${path}<name>`);
		return posix.join(path, name);
	}
	if (name === null) return path;
	const st = await remoteStat(sb, path);
	return st?.type === "dir" ? posix.join(path, name) : path;
}

async function download(
	ctx: Context,
	src: RemoteSpec,
	dst: string,
	f: CpFlags,
): Promise<unknown> {
	const sb = await useSandbox(ctx, src.sandbox);
	const call = { retryBudgetMs: ctx.transferBudgetMs };
	const info = await sb.files.stat(src.path);
	const name = posix.basename(info.path);
	if (info.type === "dir") {
		if (f.recursive !== true) {
			throw usageError(`${src.path} is a directory; use cp -r`);
		}
		if (dst === "-") throw usageError("cp -r cannot write to stdout");
		const target = localStat(dst)?.isDirectory() ? join(dst, name) : dst;
		await sb.files.downloadDir(src.path, target, call);
		return { path: target };
	}
	if (dst === "-") {
		// A reader that leaves (`| head`) ends the download, not a retry.
		const ac = new AbortController();
		const sink = new WritableStream<Uint8Array>({
			write: (b) =>
				ctx.out.data(b).catch((err: unknown) => {
					ac.abort(err);
					throw err;
				}),
		});
		await sb.files.download(src.path, sink, { ...call, signal: ac.signal });
		return undefined;
	}
	const target =
		dst.endsWith("/") || localStat(dst)?.isDirectory() ? join(dst, name) : dst;
	const r = await sb.files.download(src.path, target, call);
	await chmod(target, info.mode & 0o777).catch(() => {});
	return { path: target, sizeBytes: r.sizeBytes, etag: r.etag };
}

export function register(program: Command, run: Runner): void {
	program
		.command("cp")
		.description(
			"copy files between this machine and a sandbox: umiak cp [-r] <src> <dst>, one side <sb>:<path>",
		)
		.argument("<src>", "local path, - (stdin) or <sb>:<path>")
		.argument("<dst>", "local path, - (stdout) or <sb>:<path>")
		.option("-r, --recursive", "copy directories")
		.addHelpText(
			"after",
			[
				"",
				"<sb> is a sandbox ID or slug; :<path> is the current sandbox.",
				"Remote paths are absolute or relative to the user's home.",
				"  umiak cp ./build.tgz my-sb:/tmp/        umiak cp my-sb:out.log -",
				"  umiak cp -r ./src my-sb:project/src     umiak cp -r my-sb:results ./",
			].join("\n"),
		)
		.action(
			run(
				async (ctx, args, opts) => {
					const [src, dst] = args as [string, string];
					const f = opts as CpFlags;
					const from = src === "-" ? null : parseRemote(src);
					const to = dst === "-" ? null : parseRemote(dst);
					if ((from === null) === (to === null)) {
						throw usageError(
							"exactly one of <src> and <dst> must be <sb>:<path>",
						);
					}
					const result =
						to !== null
							? await upload(ctx, src, to, f)
							: await download(ctx, from as RemoteSpec, dst, f);
					if (ctx.out.jsonFlag && result !== undefined) ctx.out.result(result);
				},
				{ rawData: true },
			),
		);
}
