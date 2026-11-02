// Step 2 of starting a command (S7 §9.1): a `creating`/`starting` sandbox
// is awaited until ready (60 s), then `409 sandbox_starting` (retryable);
// other states are `409 sandbox_not_ready` with `details.state`; a deleted
// sandbox is 404. The sandbox is read with the principal first (the wait of
// core has no access check).
import type { Principal, Sandbox, SandboxState } from "@umiak/core";
import type { ApiDeps } from "../deps.ts";
import { ApiError, notFoundError } from "../http/errors.ts";

const STARTING: readonly SandboxState[] = ["creating", "starting"];
const WAIT_UNTIL: SandboxState[] = [
	"ready",
	"stopping",
	"stopped",
	"error",
	"deleting",
	"deleted",
];

export function sandboxNotReadyError(state: SandboxState): ApiError {
	if (state === "deleted") return notFoundError("sandbox");
	if (STARTING.includes(state)) {
		return new ApiError(
			409,
			"sandbox_starting",
			`the sandbox is still ${state}; retry in a few seconds`,
			{ retryable: true, details: { state } },
		);
	}
	return new ApiError(
		409,
		"sandbox_not_ready",
		`the sandbox is ${state}, not ready; resume or recover it first`,
		{ details: { state } },
	);
}

/**
 * `found` runs once the sandbox is read with the principal, before any
 * wait (§9.1 step 1: touchApiActivity); not for a deleted sandbox.
 */
export async function waitUntilReady(
	deps: ApiDeps,
	p: Principal,
	ref: string,
	signal?: AbortSignal,
	found?: (s: Sandbox) => Promise<void>,
): Promise<Sandbox> {
	let s = await deps.svc.get(p, ref);
	if (s.state !== "deleted") await found?.(s);
	if (STARTING.includes(s.state)) {
		// An abort ends the wait in core too (no LISTEN or poll left behind).
		s = await deps.svc.waitForState(
			s.id,
			WAIT_UNTIL,
			deps.commandTimings.readyWaitMs,
			signal,
		);
	}
	if (s.state !== "ready") throw sandboxNotReadyError(s.state);
	return s;
}
