// The config lock ($XDG_CONFIG_HOME/sbx/.lock, S7 §7.6): parallel `sbx`
// processes (CLI, SDK through `sbx auth token`, MCP) refresh the Keycloak
// token and write credentials one at a time.
// - The lock is a file created with O_CREAT|O_EXCL holding a unique owner
//   token; the holder removes it on release only while it still holds its
//   own token.
// - A holder that died leaves the file behind: a lock older than `staleMs`
//   (30 s) is taken over. Holders keep their work far below that (the token
//   refresh has a 20 s timeout, auth/token.ts).
// - The stale file is first renamed aside and removed only if it is the same
//   file (inode) that was found stale, so a lock created by another process
//   between the check and the removal is put back, not deleted.

import { randomUUID } from "node:crypto";
import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { CliError } from "../exit-codes.ts";

export interface LockOptions {
	/** A lock file older than this is stale; default 30 000 ms. */
	staleMs?: number;
	/** Give up after this long; default 60 000 ms. */
	timeoutMs?: number;
	/** Pause between attempts; default 25 ms. */
	retryMs?: number;
}

export const LOCK_STALE_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryCreate(path: string, token: string): boolean {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, token);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

function unlinkQuiet(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

/** Removes the lock file at `path` when it is older than `staleMs`. */
export function removeIfStale(path: string, staleMs: number): void {
	let found: ReturnType<typeof statSync>;
	try {
		found = statSync(path);
	} catch {
		return;
	}
	if (Date.now() - found.mtimeMs <= staleMs) return;
	const aside = `${path}.stale-${randomUUID()}`;
	try {
		renameSync(path, aside);
	} catch {
		return; // Another process removed or replaced it first.
	}
	let moved: ReturnType<typeof statSync>;
	try {
		moved = statSync(aside);
	} catch {
		return;
	}
	if (moved.ino !== found.ino || moved.dev !== found.dev) {
		// A fresh lock was created after the check: give it back, unless yet
		// another process has taken the path meanwhile.
		try {
			linkSync(aside, path);
		} catch {
			// The path is taken again; that holder owns the lock now.
		}
	}
	unlinkQuiet(aside);
}

/** Removes the lock file only while it still holds `token`. */
function release(path: string, token: string): void {
	let now: string;
	try {
		now = readFileSync(path, "utf8");
	} catch {
		return; // Removed as stale by another process.
	}
	if (now === token) unlinkQuiet(path);
}

/** Runs `fn` while holding the lock file at `path`. */
export async function withFileLock<T>(
	path: string,
	fn: () => Promise<T>,
	o: LockOptions = {},
): Promise<T> {
	const staleMs = o.staleMs ?? LOCK_STALE_MS;
	const timeoutMs = o.timeoutMs ?? 60_000;
	const retryMs = o.retryMs ?? 25;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const token = `${process.pid} ${randomUUID()} ${new Date().toISOString()}\n`;
	const start = Date.now();
	while (!tryCreate(path, token)) {
		if (Date.now() - start > timeoutMs) {
			throw new CliError({
				code: "lock_timeout",
				message: `could not take ${path} within ${timeoutMs} ms; remove it if no other sbx is running`,
				retryable: true,
			});
		}
		removeIfStale(path, staleMs);
		await sleep(retryMs);
	}
	try {
		return await fn();
	} finally {
		release(path, token);
	}
}
