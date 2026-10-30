// The config lock ($XDG_CONFIG_HOME/sbx/.lock, S7 §7.6): parallel `sbx`
// processes (CLI, SDK through `sbx auth token`, MCP) refresh the Keycloak
// token and write credentials one at a time. The lock is a file created with
// O_CREAT|O_EXCL; a holder that died leaves it behind, so a lock older than
// `staleMs` (30 s; a refresh takes far less) is removed and taken again.

import {
	closeSync,
	mkdirSync,
	openSync,
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

function tryCreate(path: string): boolean {
	try {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

/** Removes the lock file when it is older than `staleMs`. */
function removeIfStale(path: string, staleMs: number): void {
	let mtime: number;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		return;
	}
	if (Date.now() - mtime <= staleMs) return;
	try {
		unlinkSync(path);
	} catch {
		// Another process removed it first.
	}
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
	const start = Date.now();
	while (!tryCreate(path)) {
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
		try {
			unlinkSync(path);
		} catch {
			// Removed as stale by another process: nothing to release.
		}
	}
}
