// Node and Bun only parts of the SDK: built-in modules are taken from
// `process.getBuiltinModule` at call time (Node ≥ 22.3, Bun, Deno), never
// imported, so a browser bundle of the SDK has no `node:` import. In a
// browser these helpers throw `unsupported_runtime` (local paths, the system
// `tar`) or return undefined (sha256 of uploads).

import type * as ChildProcess from "node:child_process";
import type * as Crypto from "node:crypto";
import type * as Fs from "node:fs/promises";
import type * as Stream from "node:stream";
import { SbxError, UNSUPPORTED_RUNTIME } from "./errors.ts";

interface NodeProcess {
	getBuiltinModule?: (id: string) => unknown;
	env?: Record<string, string | undefined>;
}

/** A Node built-in module, or undefined where there is none (browsers). */
export function builtinModule<T>(id: string): T | undefined {
	const proc = (globalThis as { process?: NodeProcess }).process;
	if (typeof proc?.getBuiltinModule !== "function") return undefined;
	return proc.getBuiltinModule(id) as T | undefined;
}

function need<T>(id: string, what: string): T {
	const m = builtinModule<T>(id);
	if (m === undefined) {
		throw new SbxError({
			status: 0,
			code: UNSUPPORTED_RUNTIME,
			message: `${what} needs Node or Bun (${id})`,
			retryable: false,
		});
	}
	return m;
}

export const childProcess = (what: string) =>
	need<typeof ChildProcess>("node:child_process", what);
export const fsPromises = (what: string) =>
	need<typeof Fs>("node:fs/promises", what);
const stream = (what: string) => need<typeof Stream>("node:stream", what);

/** An incremental SHA-256 (hex), or undefined without node:crypto. */
export function sha256Hasher():
	| { update(b: Uint8Array): void; hex(): string }
	| undefined {
	const crypto = builtinModule<typeof Crypto>("node:crypto");
	if (crypto === undefined) return undefined;
	const h = crypto.createHash("sha256");
	return {
		update: (b) => {
			h.update(b);
		},
		hex: () => h.digest("hex"),
	};
}

interface TarProcess {
	child: ChildProcess.ChildProcess;
	/** Resolves on exit 0; rejects with the stderr of tar otherwise. */
	done: Promise<void>;
}

function runTar(args: string[], what: string): TarProcess {
	const cp = childProcess(what);
	const proc = (globalThis as { process?: NodeProcess }).process;
	const child = cp.spawn("tar", args, {
		stdio: ["pipe", "pipe", "pipe"],
		// macOS bsdtar: no AppleDouble `._*` entries.
		env: { ...proc?.env, COPYFILE_DISABLE: "1" },
		windowsHide: true,
	});
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (s: string) => {
		if (stderr.length < 4096) stderr += s;
	});
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", (err) =>
			reject(
				new SbxError({
					status: 0,
					code: UNSUPPORTED_RUNTIME,
					message: `cannot run tar: ${err.message}`,
					retryable: false,
					cause: err,
				}),
			),
		);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new SbxError({
					status: 0,
					code: LOCAL_TAR_FAILED,
					message: `tar ${args[0]} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`,
					retryable: false,
				}),
			);
		});
	});
	// A rejection nobody awaits yet must not be unhandled.
	done.catch(() => {});
	return { child, done };
}

/** The local `tar` failed (a bad directory, a short archive). */
export const LOCAL_TAR_FAILED = "local_tar_failed";

/**
 * `tar -cz` of the top-level `names` of `dir`, as a web stream that errors
 * when tar fails, so an upload never ends as a short archive. `list`: the
 * whole list of paths instead (NUL-terminated bytes, not recursed into),
 * passed to tar on stdin (`--null -T -`), so a long list never hits the argv
 * limit and names need not be UTF-8.
 */
export function tarCreate(
	dir: string,
	names: string[],
	o: { list?: Uint8Array } = {},
): { body: ReadableStream<Uint8Array>; done: Promise<void>; kill(): void } {
	const { child, done } = runTar(
		o.list !== undefined
			? [
					"-c",
					"-z",
					"-f",
					"-",
					"-C",
					dir,
					"--no-recursion",
					"--null",
					"-T",
					"-",
				]
			: ["-c", "-z", "-f", "-", "-C", dir, "--", ...names],
		"uploadDir",
	);
	child.stdin?.on("error", () => {
		// tar exited early; its exit status reports why.
	});
	child.stdin?.end(o.list);
	const reader = (
		stream("uploadDir").Readable.toWeb(
			child.stdout as Stream.Readable,
		) as ReadableStream<Uint8Array>
	).getReader();
	const kill = () => {
		if (child.exitCode === null) child.kill("SIGKILL");
	};
	const body = new ReadableStream<Uint8Array>({
		async pull(c) {
			const r = await reader.read();
			if (!r.done) {
				c.enqueue(r.value);
				return;
			}
			try {
				await done;
				c.close();
			} catch (err) {
				c.error(err);
			}
		},
		cancel: kill,
	});
	return { body, done, kill };
}

/** `tar -xz` into `dir`: a web sink for the archive bytes. */
export function tarExtract(dir: string): {
	sink: WritableStream<Uint8Array>;
	done: Promise<void>;
	kill(): void;
} {
	const { child, done } = runTar(
		["-x", "-z", "-f", "-", "-C", dir, "--no-same-owner"],
		"downloadDir",
	);
	child.stdout?.resume();
	const sink = stream("downloadDir").Writable.toWeb(
		child.stdin as Stream.Writable,
	) as WritableStream<Uint8Array>;
	return {
		sink,
		done,
		kill: () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		},
	};
}
