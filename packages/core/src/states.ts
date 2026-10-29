import { invalidState } from "./errors.ts";

// State machines of S6 §6. Each `*Next` returns the target state or throws
// SbxError `invalid_state` with `details {state, event}`. Callers persist the
// result with a conditional UPDATE (`WHERE state = <from>`).

export const SANDBOX_STATES = [
	"creating",
	"ready",
	"stopping",
	"stopped",
	"starting",
	"error",
	"deleting",
	"deleted",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const MACHINE_STATES = [
	"allocating",
	"provisioning",
	"booting",
	"warm",
	"claiming",
	"running",
	"stopping",
	"stopped",
	"starting",
	"failed",
	"deleting",
	"deleted",
] as const;
export type MachineState = (typeof MACHINE_STATES)[number];

export const OPERATION_STATES = [
	"pending",
	"running",
	"succeeded",
	"failed",
	"superseded",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const ACTIVE_OPERATION_STATES: readonly OperationState[] = [
	"pending",
	"running",
];
export const TERMINAL_OPERATION_STATES: readonly OperationState[] = [
	"succeeded",
	"failed",
	"superseded",
];

/**
 * Machines counted in `reserved` RAM (S6 §8.1). A `stopped` machine is also
 * reserved while a pending/running resume or recover exists; that condition
 * needs the operations table and is applied by the query, not here.
 */
export const RESERVED_MACHINE_STATES: readonly MachineState[] = [
	"allocating",
	"provisioning",
	"booting",
	"warm",
	"claiming",
	"running",
	"starting",
	"stopping",
];

/**
 * Machines counted in `powered` RAM (S6 §8.1). `failed`, `deleting` and
 * `stopped` machines also count while `power_observed <> 'stopped'`; the query
 * applies that condition.
 */
export const POWERED_MACHINE_STATES: readonly MachineState[] = [
	"booting",
	"warm",
	"claiming",
	"running",
	"starting",
	"stopping",
];

// ---------------------------------------------------------------------------
// Sandbox (S6 §6.1). One event per row of the transitions table.

export const SANDBOX_EVENTS = [
	"create", // (none) -> creating: create, fork target, create from saved snapshot
	"create_done", // creating -> ready
	"create_failed", // creating -> error
	"stop", // ready -> stopping (user, TTL, idle)
	"stop_done", // stopping -> stopped
	"stop_failed", // stopping -> error (stop_failed)
	"unexpected_stop_first", // ready -> starting (system resume, §11.3)
	"unexpected_stop_repeat", // ready -> stopped (unexpected_shutdown, §11.3)
	"resume", // stopped -> starting; error -> starting if machine is stopped
	"resume_done", // starting -> ready
	"resume_failed", // starting -> error (resume_failed)
	"recover", // ready -> starting; error -> starting if machine not failed/deleting/deleted
	"fork", // ready|stopped -> unchanged (operation on the source)
	"save_snapshot", // ready|stopped -> unchanged (operation on the source)
	"delete", // any except deleting/deleted -> deleting
	"delete_done", // deleting -> deleted
	"machine_lost", // creating|ready|stopped|starting|stopping -> error (machine_lost)
] as const;
export type SandboxEvent = (typeof SANDBOX_EVENTS)[number];

export interface SandboxTransitionContext {
	/** State of the sandbox's current machine; null/undefined if it has none. */
	machineState?: MachineState | null | undefined;
}

type SandboxRule = {
	from: readonly (SandboxState | null)[];
	to: SandboxState | "same";
	when?: (ctx: SandboxTransitionContext) => boolean;
};

const ALL_BUT_DELETING: readonly SandboxState[] = SANDBOX_STATES.filter(
	(s) => s !== "deleting" && s !== "deleted",
);

const SANDBOX_RULES: Record<SandboxEvent, readonly SandboxRule[]> = {
	create: [{ from: [null], to: "creating" }],
	create_done: [{ from: ["creating"], to: "ready" }],
	create_failed: [{ from: ["creating"], to: "error" }],
	stop: [{ from: ["ready"], to: "stopping" }],
	stop_done: [{ from: ["stopping"], to: "stopped" }],
	stop_failed: [{ from: ["stopping"], to: "error" }],
	unexpected_stop_first: [{ from: ["ready"], to: "starting" }],
	unexpected_stop_repeat: [{ from: ["ready"], to: "stopped" }],
	resume: [
		{ from: ["stopped"], to: "starting" },
		// VM and disks are in place.
		{
			from: ["error"],
			to: "starting",
			when: (c) => c.machineState === "stopped",
		},
	],
	resume_done: [{ from: ["starting"], to: "ready" }],
	resume_failed: [{ from: ["starting"], to: "error" }],
	recover: [
		{ from: ["ready"], to: "starting" },
		{
			from: ["error"],
			to: "starting",
			when: (c) =>
				c.machineState != null &&
				c.machineState !== "failed" &&
				c.machineState !== "deleting" &&
				c.machineState !== "deleted",
		},
	],
	fork: [{ from: ["ready", "stopped"], to: "same" }],
	save_snapshot: [{ from: ["ready", "stopped"], to: "same" }],
	delete: [{ from: ALL_BUT_DELETING, to: "deleting" }],
	delete_done: [{ from: ["deleting"], to: "deleted" }],
	// "Without an active operation" is checked by the reconciler's query.
	machine_lost: [
		{
			from: ["creating", "ready", "stopped", "starting", "stopping"],
			to: "error",
		},
	],
};

/** `from = null` means the sandbox row does not exist yet (only `create`). */
export function sandboxNext(
	from: SandboxState | null,
	ev: SandboxEvent,
	ctx: SandboxTransitionContext = {},
): SandboxState {
	for (const rule of SANDBOX_RULES[ev]) {
		if (
			rule.from.includes(from) &&
			(rule.when === undefined || rule.when(ctx))
		) {
			if (rule.to === "same") {
				if (from === null) break;
				return from;
			}
			return rule.to;
		}
	}
	throw invalidState(from, { event: ev });
}

// ---------------------------------------------------------------------------
// Machine (S6 §6.2). Encoded table (executor rules, the §6.2 diagram is informal):
//
//   allocated          allocating   -> provisioning
//   provisioned_start  provisioning -> booting       (RAM check, then S1 start)
//   pool_ready         booting      -> warm          (pool machine, no sandbox_id)
//   claim              warm         -> claiming      (pool claim)
//                      booting      -> claiming      (cold path, sandbox_id already set)
//   claimed            claiming     -> running
//   stop               running      -> stopping
//   stopped            stopping     -> stopped
//   unexpected_stop    running      -> stopped       (reconcile, §11.3)
//   start              stopped      -> starting      (resume, recover of a stopped machine)
//   started            starting     -> running
//   start_failed       starting     -> stopped       (resume/recover failure: hard stop, §7.6)
//   reset              running|stopping|starting -> starting (recover power-cycle, §7.8)
//   fail               any except failed/deleting/deleted -> failed
//   delete             any except deleting/deleted -> deleting
//   deleted            deleting     -> deleted       (terminal)
//
// Nothing leads back to `warm` except `pool_ready` from `booting`, so a machine
// that reached `claiming` never returns to the pool (§6.4 p. 2).

export const MACHINE_EVENTS = [
	"allocated",
	"provisioned_start",
	"pool_ready",
	"claim",
	"claimed",
	"stop",
	"stopped",
	"unexpected_stop",
	"start",
	"started",
	"start_failed",
	"reset",
	"fail",
	"delete",
	"deleted",
] as const;
export type MachineEvent = (typeof MACHINE_EVENTS)[number];

export interface MachineTransitionContext {
	/** `machines.sandbox_id` is set. */
	hasSandbox?: boolean;
}

type MachineRule = {
	from: readonly MachineState[];
	to: MachineState;
	when?: (ctx: MachineTransitionContext) => boolean;
};

const MACHINE_LIVE: readonly MachineState[] = MACHINE_STATES.filter(
	(s) => s !== "failed" && s !== "deleting" && s !== "deleted",
);

const MACHINE_RULES: Record<MachineEvent, readonly MachineRule[]> = {
	allocated: [{ from: ["allocating"], to: "provisioning" }],
	provisioned_start: [{ from: ["provisioning"], to: "booting" }],
	pool_ready: [
		{ from: ["booting"], to: "warm", when: (c) => c.hasSandbox !== true },
	],
	claim: [
		{ from: ["warm"], to: "claiming" },
		{ from: ["booting"], to: "claiming", when: (c) => c.hasSandbox === true },
	],
	claimed: [{ from: ["claiming"], to: "running" }],
	stop: [{ from: ["running"], to: "stopping" }],
	stopped: [{ from: ["stopping"], to: "stopped" }],
	unexpected_stop: [{ from: ["running"], to: "stopped" }],
	start: [{ from: ["stopped"], to: "starting" }],
	started: [{ from: ["starting"], to: "running" }],
	start_failed: [{ from: ["starting"], to: "stopped" }],
	reset: [{ from: ["running", "stopping", "starting"], to: "starting" }],
	fail: [{ from: MACHINE_LIVE, to: "failed" }],
	delete: [{ from: [...MACHINE_LIVE, "failed"], to: "deleting" }],
	deleted: [{ from: ["deleting"], to: "deleted" }],
};

export function machineNext(
	from: MachineState,
	ev: MachineEvent,
	ctx: MachineTransitionContext = {},
): MachineState {
	for (const rule of MACHINE_RULES[ev]) {
		if (
			rule.from.includes(from) &&
			(rule.when === undefined || rule.when(ctx))
		) {
			return rule.to;
		}
	}
	throw invalidState(from, { event: ev });
}

// ---------------------------------------------------------------------------
// Operation (S6 §6.3): pending -> running -> succeeded | failed | superseded.
// `retry` keeps `running` (the caller increments `attempt`); terminal states are final.

export const OPERATION_EVENTS = [
	"start",
	"retry",
	"succeed",
	"fail",
	"supersede",
] as const;
export type OperationEvent = (typeof OPERATION_EVENTS)[number];

const OPERATION_RULES: Record<
	OperationEvent,
	{ from: readonly OperationState[]; to: OperationState }
> = {
	start: { from: ["pending"], to: "running" },
	retry: { from: ["running"], to: "running" },
	succeed: { from: ACTIVE_OPERATION_STATES, to: "succeeded" },
	fail: { from: ACTIVE_OPERATION_STATES, to: "failed" },
	supersede: { from: ACTIVE_OPERATION_STATES, to: "superseded" },
};

export function operationNext(
	from: OperationState,
	ev: OperationEvent,
): OperationState {
	const rule = OPERATION_RULES[ev];
	if (!rule.from.includes(from)) throw invalidState(from, { event: ev });
	return rule.to;
}
