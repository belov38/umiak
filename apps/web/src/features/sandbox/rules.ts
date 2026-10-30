// What the sandbox page offers in a state (S8 §9.6) and why something is
// off. A blocked sandbox keeps reads, stop and delete only (S8 §17.1 C3);
// the API refuses the rest with 403 sandbox_blocked anyway.
import type { SandboxData } from "@sbx/sdk";
import { canDelete, canFork, canResume, canStop } from "@/lib/sandboxes";

export type Gate = { ok: true } | { ok: false; reason: string };

const OK: Gate = { ok: true };
const BLOCKED: Gate = {
	ok: false,
	reason:
		"A platform operator blocked this sandbox: only reading, stop and delete work.",
};

function gone(s: SandboxData): boolean {
	return s.state === "deleting" || s.state === "deleted";
}

function notReady(s: SandboxData): Gate {
	return {
		ok: false,
		reason: `The sandbox is ${s.state}; this needs a ready sandbox.`,
	};
}

/** Commands, terminals and file writes: a ready sandbox, not blocked. */
export function canWork(s: SandboxData): Gate {
	if (s.blocked) return BLOCKED;
	return s.state === "ready" ? OK : notReady(s);
}

/** Reading files and command output needs the VM running. */
export function canRead(s: SandboxData): Gate {
	return s.state === "ready" ? OK : notReady(s);
}

/** Publishing ports and editing env work in any state but deleting. */
export function canConfigure(s: SandboxData): Gate {
	if (s.blocked) return BLOCKED;
	if (gone(s)) return { ok: false, reason: `The sandbox is ${s.state}.` };
	return OK;
}

/** Recover: ready (power-cycle) or error, no operation running. */
export function canRecover(s: SandboxData): boolean {
	return (
		(s.state === "ready" || s.state === "error") &&
		!s.blocked &&
		s.activeOperation === null
	);
}

/** Extend: a ready sandbox with a TTL. */
export function canExtend(s: SandboxData): boolean {
	return (
		s.state === "ready" &&
		!s.blocked &&
		(s.ttlSeconds !== null || s.deadlineAt !== null)
	);
}

/** Save snapshot: ready or stopped, not blocked. */
export function canSaveSnapshot(s: SandboxData): boolean {
	return (s.state === "ready" || s.state === "stopped") && !s.blocked;
}

/** Rename (PATCH slug): not going away, not blocked. */
export function canRename(s: SandboxData): boolean {
	return !gone(s) && !s.blocked;
}

export interface HeaderActions {
	stop: boolean;
	resume: boolean;
	fork: boolean;
	recover: boolean;
	extend: boolean;
	saveSnapshot: boolean;
	rename: boolean;
	delete: boolean;
}

export function headerActions(s: SandboxData): HeaderActions {
	return {
		stop: canStop(s),
		resume: canResume(s),
		fork: canFork(s),
		recover: canRecover(s),
		extend: canExtend(s),
		saveSnapshot: canSaveSnapshot(s),
		rename: canRename(s),
		delete: canDelete(s),
	};
}

/** Name of a saved snapshot (S7 §13). */
export const SNAPSHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A port the API may publish (S7 §11.2): 1–65535, not 22. */
export function portProblem(text: string): string | null {
	const t = text.trim();
	if (!/^\d+$/.test(t)) return "A number from 1 to 65535";
	const n = Number(t);
	if (n < 1 || n > 65535) return "A number from 1 to 65535";
	if (n === 22) return "Port 22 is SSH of the platform";
	return null;
}

/** `https://slug-{port}.domain` → the URL of `port`. */
export function portUrl(template: string, port: number): string {
	return template.replace("{port}", String(port));
}

/** Seconds as `15 min`, `2 h`, `1 d 3 h`; null → "none". */
export function formatSeconds(s: number | null): string {
	if (s === null) return "none";
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.round(s / 60)} min`;
	if (s < 86_400) {
		const h = Math.floor(s / 3600);
		const m = Math.round((s % 3600) / 60);
		return m === 0 ? `${h} h` : `${h} h ${m} min`;
	}
	const d = Math.floor(s / 86_400);
	const h = Math.round((s % 86_400) / 3600);
	return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** `0644` from mode bits, `drwxr-xr-x` style with the type letter. */
export function modeString(type: string, mode: number): string {
	const t = type === "dir" ? "d" : type === "symlink" ? "l" : "-";
	const bits = ["r", "w", "x"];
	let out = t;
	for (let i = 8; i >= 0; i--) {
		out += mode & (1 << i) ? bits[(8 - i) % 3] : "-";
	}
	return out;
}

/** `1.2 KB`, `3.4 MB`; bytes below 1 KiB as `512 B`. */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
