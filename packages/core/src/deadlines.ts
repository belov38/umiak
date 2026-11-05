import type { TemplateOs } from "@umiak/config";
import type { OperationKind } from "./rows.ts";

// Operation deadlines (S6 §7.9). `operations.deadline_at = created_at + deadline`;
// an expired operation compensates and fails on its next attempt (§7.1 p. 3).

const MIN = 60_000;

type Pair = { linux: number; windows: number };

// Cold create, create from a saved snapshot and the target of a fork.
const CREATE_COLD: Pair = { linux: 6 * MIN, windows: 20 * MIN };

const DEADLINES: Record<Exclude<OperationKind, "create" | "delete">, Pair> = {
	fork: { linux: 2 * MIN, windows: 3 * MIN },
	// Windows: the guest gets up to 300 s to shut down cleanly (S9 §24.9),
	// plus PrepareStop, VM-lock retries and the verify.
	stop: { linux: 3 * MIN, windows: 7 * MIN },
	resume: { linux: 5 * MIN, windows: 15 * MIN },
	recover: { linux: 5 * MIN, windows: 15 * MIN },
	// Not in §7.9: reprovision delivers like the provision step of resume.
	reprovision: { linux: 5 * MIN, windows: 15 * MIN },
	save_snapshot: { linux: 5 * MIN, windows: 5 * MIN },
};

/**
 * Deadline of an operation in ms, or null for delete (it never gives up).
 * `forceStop` (fork and save_snapshot of a running Windows sandbox, S9
 * §24.8) adds the stop deadline: the operation stops the source first. The
 * restart after the snapshot gets its own budget (`FORCE_STOP_RESTART_MS`).
 */
export function operationDeadline(
	kind: OperationKind,
	os: TemplateOs,
	opts: { forceStop?: boolean } = {},
): number | null {
	if (kind === "delete") return null;
	if (kind === "create") {
		return CREATE_COLD[os];
	}
	const base = DEADLINES[kind][os];
	if (opts.forceStop && (kind === "fork" || kind === "save_snapshot")) {
		return base + DEADLINES.stop[os];
	}
	return base;
}

/**
 * After the snapshot of a force-stopped source, the operation's deadline is
 * moved to at least now + this (the resume deadline): the source is started
 * again and its failure must not fail the fork (S9 §24.8).
 */
export function forceStopRestartMs(os: TemplateOs): number {
	return DEADLINES.resume[os];
}
