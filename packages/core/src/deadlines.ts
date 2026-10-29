import type { TemplateOs } from "@sbx/config";
import type { OperationKind } from "./rows.ts";

// Operation deadlines (S6 §7.9). `operations.deadline_at = created_at + deadline`;
// an expired operation compensates and fails on its next attempt (§7.1 p. 3).

const MIN = 60_000;

type Pair = { linux: number; windows: number };

const CREATE_FROM_POOL: Pair = { linux: 2 * MIN, windows: 5 * MIN };
// Cold create, create from a saved snapshot and the target of a fork.
const CREATE_COLD: Pair = { linux: 6 * MIN, windows: 20 * MIN };

const DEADLINES: Record<Exclude<OperationKind, "create" | "delete">, Pair> = {
	fork: { linux: 2 * MIN, windows: 3 * MIN },
	stop: { linux: 3 * MIN, windows: 5 * MIN },
	resume: { linux: 5 * MIN, windows: 15 * MIN },
	recover: { linux: 5 * MIN, windows: 15 * MIN },
	// Not in §7.9: reprovision delivers like the provision step of resume.
	reprovision: { linux: 5 * MIN, windows: 15 * MIN },
	save_snapshot: { linux: 5 * MIN, windows: 5 * MIN },
};

/** Deadline of an operation in ms, or null for delete (it never gives up). */
export function operationDeadline(
	kind: OperationKind,
	os: TemplateOs,
	opts: { fromPool?: boolean } = {},
): number | null {
	if (kind === "delete") return null;
	if (kind === "create") {
		return (opts.fromPool ? CREATE_FROM_POOL : CREATE_COLD)[os];
	}
	return DEADLINES[kind][os];
}
