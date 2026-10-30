// The current sandbox of a shell (S7 §14.2) and how commands pick their
// sandbox: `<sb>` (ID or slug), then SBX_SANDBOX, then the current sandbox
// of this shell, then (inside a VM) SBX_SANDBOX_ID, a core UUID turned into
// `sb_…` (S7 §5.3).
//
// The shell key is SBX_SESSION, else the parent PID and its start time (a
// reused PID gets another key). State: $XDG_STATE_HOME/sbx/current/<key>;
// entries older than 7 days are removed when one is written.

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "@sbx/sdk";
import { writePrivateFile } from "./config.ts";
import type { Context } from "./context.ts";
import { usageError } from "./exit-codes.ts";

const MAX_AGE_MS = 7 * 86_400_000;

/** Crockford base32 without i, l, o, u (S7 §5.3). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A core UUID as a public sandbox id `sb_…`; null if not a UUID. */
export function sandboxIdOfUuid(uuid: string): string | null {
	if (!UUID_RE.test(uuid)) return null;
	let n = BigInt(`0x${uuid.replaceAll("-", "")}`);
	let body = "";
	for (let i = 0; i < 26; i++) {
		body = ALPHABET[Number(n & 31n)] + body;
		n >>= 5n;
	}
	return `sb_${body}`;
}

/** Start time of a process, as a stable string; "" when unknown. */
function processStart(pid: number): string {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 22 (starttime), counted after the "(comm)" field.
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
		} catch {
			return "";
		}
	}
	if (process.platform === "win32") return "";
	const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
	});
	return r.status === 0 ? r.stdout.trim() : "";
}

export function shellKey(env: Record<string, string | undefined>): string {
	const raw =
		env.SBX_SESSION !== undefined && env.SBX_SESSION !== ""
			? `session-${env.SBX_SESSION}`
			: `ppid-${process.ppid}-${processStart(process.ppid)}`;
	return raw.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200);
}

function currentFile(ctx: Context): string {
	return join(ctx.paths.stateDir, "current", shellKey(ctx.env));
}

/** The current sandbox id of this shell, or null. */
export function readCurrent(ctx: Context): string | null {
	const file = currentFile(ctx);
	try {
		if (Date.now() - statSync(file).mtimeMs > MAX_AGE_MS) return null;
		const v = JSON.parse(readFileSync(file, "utf8")) as { sandbox?: unknown };
		return typeof v.sandbox === "string" ? v.sandbox : null;
	} catch {
		return null;
	}
}

export function writeCurrent(ctx: Context, sandboxId: string): void {
	const file = currentFile(ctx);
	writePrivateFile(file, `${JSON.stringify({ sandbox: sandboxId })}\n`);
	pruneOld(join(ctx.paths.stateDir, "current"));
}

export function clearCurrent(ctx: Context): void {
	try {
		unlinkSync(currentFile(ctx));
	} catch {
		// Nothing was current.
	}
}

function pruneOld(dir: string): void {
	mkdirSync(dir, { recursive: true });
	for (const name of readdirSync(dir)) {
		const f = join(dir, name);
		try {
			if (Date.now() - statSync(f).mtimeMs > MAX_AGE_MS) unlinkSync(f);
		} catch {
			// Removed meanwhile.
		}
	}
}

export interface SandboxRef {
	/** ID (`sb_…`) or slug. */
	ref: string;
	/** Given as `<sb>` on the command line. */
	explicit: boolean;
}

/** Which sandbox a command means (see the header); usage error (exit 2) if none. */
export function sandboxRef(ctx: Context, arg: string | undefined): SandboxRef {
	if (arg !== undefined && arg !== "") return { ref: arg, explicit: true };
	const env = ctx.env.SBX_SANDBOX;
	if (env !== undefined && env !== "") return { ref: env, explicit: false };
	const current = readCurrent(ctx);
	if (current !== null) return { ref: current, explicit: false };
	const inVm = ctx.env.SBX_SANDBOX_ID;
	const fromVm = inVm === undefined ? null : sandboxIdOfUuid(inVm);
	if (fromVm !== null) return { ref: fromVm, explicit: false };
	throw usageError(
		"no sandbox: pass <sb> (ID or slug), set SBX_SANDBOX, or pick one with: sbx current <sb>",
	);
}

/**
 * Reads the sandbox a command means. An explicit `<sb>` becomes the current
 * sandbox of this shell.
 */
export async function useSandbox(
	ctx: Context,
	arg: string | undefined,
): Promise<Sandbox> {
	const r = sandboxRef(ctx, arg);
	const sb = await ctx.sbx().sandboxes.get(r.ref);
	if (r.explicit) writeCurrent(ctx, sb.id);
	return sb;
}
