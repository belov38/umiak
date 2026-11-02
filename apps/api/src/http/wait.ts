// Long-poll reads (S7 §5.10). `waitForState` and `waitForOperation` of core
// have no access check, so the resource is always read with the principal
// first; only then does the wait start.
import {
	type Operation,
	type Principal,
	type Sandbox,
	type SandboxService,
	type SandboxState,
	TERMINAL_OPERATION_STATES,
} from "@umiak/core";
import { notFoundError } from "./errors.ts";

export const MAX_WAIT_SECONDS = 60;

/** Waiting also ends in these states: the awaited one will not come. */
export const WAIT_END_STATES: readonly SandboxState[] = [
	"error",
	"deleting",
	"deleted",
];

/**
 * The sandbox now, or once its state is in `waitFor` (or an end state)
 * within `waitSeconds`. No waiting without `waitFor` or with 0 seconds.
 */
export async function waitForSandbox(
	svc: SandboxService,
	p: Principal,
	ref: string,
	waitFor: readonly SandboxState[] | undefined,
	waitSeconds: number,
): Promise<Sandbox> {
	const s = await svc.get(p, ref);
	if (waitFor === undefined || waitFor.length === 0 || waitSeconds <= 0) {
		return s;
	}
	const states = [...new Set([...waitFor, ...WAIT_END_STATES])];
	if (states.includes(s.state)) return s;
	return svc.waitForState(s.id, states, waitSeconds * 1000);
}

/** Internal operations (`reprovision`) are not part of the API. */
export function isPublicOperation(op: Operation): boolean {
	return op.kind !== "reprovision";
}

/** The team's operation now, or once terminal within `waitSeconds`. */
export async function waitForOperation(
	svc: SandboxService,
	p: Principal,
	id: string,
	waitSeconds: number,
): Promise<Operation> {
	const op = await svc.getOperation(p, id);
	if (!isPublicOperation(op)) throw notFoundError("operation");
	if (waitSeconds <= 0 || TERMINAL_OPERATION_STATES.includes(op.state)) {
		return op;
	}
	return svc.waitForOperation(op.id, waitSeconds * 1000);
}
