import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	MACHINE_EVENTS,
	MACHINE_STATES,
	type MachineEvent,
	type MachineState,
	machineNext,
	OPERATION_EVENTS,
	OPERATION_STATES,
	type OperationEvent,
	type OperationState,
	operationNext,
	POWERED_MACHINE_STATES,
	RESERVED_MACHINE_STATES,
	SANDBOX_EVENTS,
	SANDBOX_STATES,
	type SandboxEvent,
	type SandboxState,
	SbxError,
	sandboxNext,
} from "../src/index.ts";

function outcome<T>(fn: () => T): T | "invalid" {
	try {
		return fn();
	} catch (e) {
		expect(e).toBeInstanceOf(SbxError);
		expect((e as SbxError).code).toBe("invalid_state");
		return "invalid";
	}
}

// Independent restatement of S6 §6.1 used as the oracle.
function expectedSandbox(
	from: SandboxState | null,
	ev: SandboxEvent,
	machine: MachineState | null | undefined,
): SandboxState | "invalid" {
	const is = (...s: (SandboxState | null)[]) => s.includes(from);
	switch (ev) {
		case "create":
			return from === null ? "creating" : "invalid";
		case "create_done":
			return is("creating") ? "ready" : "invalid";
		case "create_failed":
			return is("creating") ? "error" : "invalid";
		case "stop":
			return is("ready") ? "stopping" : "invalid";
		case "stop_done":
			return is("stopping") ? "stopped" : "invalid";
		case "stop_failed":
			return is("stopping") ? "error" : "invalid";
		case "unexpected_stop_first":
			return is("ready") ? "starting" : "invalid";
		case "unexpected_stop_repeat":
			return is("ready") ? "stopped" : "invalid";
		case "resume":
			if (is("stopped")) return "starting";
			if (is("error") && machine === "stopped") return "starting";
			return "invalid";
		case "resume_done":
			return is("starting") ? "ready" : "invalid";
		case "resume_failed":
			return is("starting") ? "error" : "invalid";
		case "recover":
			if (is("ready")) return "starting";
			if (
				is("error") &&
				machine != null &&
				!["failed", "deleting", "deleted"].includes(machine)
			)
				return "starting";
			return "invalid";
		case "fork":
		case "save_snapshot":
			return from === "ready" || from === "stopped" ? from : "invalid";
		case "delete":
			return from !== null && !is("deleting", "deleted")
				? "deleting"
				: "invalid";
		case "delete_done":
			return is("deleting") ? "deleted" : "invalid";
		case "machine_lost":
			return is("creating", "ready", "stopped", "starting", "stopping")
				? "error"
				: "invalid";
	}
}

describe("sandboxNext", () => {
	it("allows exactly the S6 §6.1 transitions", () => {
		let allowed = 0;
		for (const from of [null, ...SANDBOX_STATES]) {
			for (const ev of SANDBOX_EVENTS) {
				for (const machine of [undefined, null, ...MACHINE_STATES]) {
					const want = expectedSandbox(from, ev, machine);
					const got = outcome(() =>
						sandboxNext(from, ev, { machineState: machine }),
					);
					expect(got, `${from} --${ev}--> (machine ${machine})`).toBe(want);
					if (want !== "invalid") allowed++;
				}
			}
		}
		expect(allowed).toBeGreaterThan(0);
	});

	it("reports the current state in invalid_state", () => {
		try {
			sandboxNext("stopped", "stop");
			expect.unreachable();
		} catch (e) {
			expect((e as SbxError).details).toEqual({
				state: "stopped",
				event: "stop",
			});
		}
	});

	it("resume from error needs the machine stopped", () => {
		expect(sandboxNext("error", "resume", { machineState: "stopped" })).toBe(
			"starting",
		);
		expect(outcome(() => sandboxNext("error", "resume"))).toBe("invalid");
		expect(
			outcome(() =>
				sandboxNext("error", "resume", { machineState: "running" }),
			),
		).toBe("invalid");
	});

	it("recover from error needs a live machine", () => {
		expect(sandboxNext("error", "recover", { machineState: "running" })).toBe(
			"starting",
		);
		for (const m of ["failed", "deleting", "deleted"] as const) {
			expect(
				outcome(() => sandboxNext("error", "recover", { machineState: m })),
			).toBe("invalid");
		}
		expect(outcome(() => sandboxNext("error", "recover"))).toBe("invalid");
	});

	it("deleted is terminal and never left (property)", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.constantFrom(...SANDBOX_EVENTS),
						fc.constantFrom(undefined, ...MACHINE_STATES),
					),
					{ maxLength: 60 },
				),
				(events) => {
					let state: SandboxState = "ready";
					for (const [ev, machine] of events) {
						const next = outcome(() =>
							sandboxNext(state, ev, { machineState: machine }),
						);
						if (state === "deleted") expect(next).toBe("invalid");
						if (next !== "invalid") state = next;
					}
				},
			),
			{ numRuns: 2000 },
		);
	});
});

const NON_FINAL_FOR_FAIL: MachineState[] = [
	"allocating",
	"provisioning",
	"booting",
	"warm",
	"claiming",
	"running",
	"stopping",
	"stopped",
	"starting",
];

// Independent restatement of the machine table (S6 §6.2 + executor rules).
function expectedMachine(
	from: MachineState,
	ev: MachineEvent,
	hasSandbox: boolean,
): MachineState | "invalid" {
	const pairs: Record<MachineEvent, [MachineState[], MachineState]> = {
		allocated: [["allocating"], "provisioning"],
		provisioned_start: [["provisioning"], "booting"],
		pool_ready: [hasSandbox ? [] : ["booting"], "warm"],
		claim: [hasSandbox ? ["warm", "booting"] : ["warm"], "claiming"],
		claimed: [["claiming"], "running"],
		stop: [["running"], "stopping"],
		stopped: [["stopping"], "stopped"],
		unexpected_stop: [["running"], "stopped"],
		start: [["stopped"], "starting"],
		started: [["starting"], "running"],
		start_failed: [["starting"], "stopped"],
		reset: [["running", "stopping", "starting"], "starting"],
		fail: [NON_FINAL_FOR_FAIL, "failed"],
		delete: [[...NON_FINAL_FOR_FAIL, "failed"], "deleting"],
		deleted: [["deleting"], "deleted"],
	};
	const [froms, to] = pairs[ev];
	return froms.includes(from) ? to : "invalid";
}

describe("machineNext", () => {
	it("allows exactly the encoded machine transitions", () => {
		for (const from of MACHINE_STATES) {
			for (const ev of MACHINE_EVENTS) {
				for (const hasSandbox of [false, true]) {
					expect(
						outcome(() => machineNext(from, ev, { hasSandbox })),
						`${from} --${ev}--> (hasSandbox ${hasSandbox})`,
					).toBe(expectedMachine(from, ev, hasSandbox));
				}
			}
		}
	});

	it("cold path: claim from booting only with a sandbox", () => {
		expect(machineNext("booting", "claim", { hasSandbox: true })).toBe(
			"claiming",
		);
		expect(outcome(() => machineNext("booting", "claim"))).toBe("invalid");
		expect(
			outcome(() => machineNext("booting", "pool_ready", { hasSandbox: true })),
		).toBe("invalid");
	});

	it("never returns from claiming to warm (property)", () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.constantFrom(...MACHINE_EVENTS), fc.boolean()), {
					maxLength: 60,
				}),
				(events) => {
					let state: MachineState = "claiming";
					for (const [ev, hasSandbox] of events) {
						const next = outcome(() => machineNext(state, ev, { hasSandbox }));
						if (state === "deleted") expect(next).toBe("invalid");
						if (next !== "invalid") state = next;
						expect(state).not.toBe("warm");
					}
				},
			),
			{ numRuns: 2000 },
		);
	});

	it("exports the RAM accounting sets of §8.1", () => {
		expect([...RESERVED_MACHINE_STATES].sort()).toEqual(
			[
				"allocating",
				"provisioning",
				"booting",
				"warm",
				"claiming",
				"running",
				"starting",
				"stopping",
			].sort(),
		);
		expect([...POWERED_MACHINE_STATES].sort()).toEqual(
			["booting", "warm", "claiming", "running", "starting", "stopping"].sort(),
		);
	});
});

function expectedOperation(
	from: OperationState,
	ev: OperationEvent,
): OperationState | "invalid" {
	const active = from === "pending" || from === "running";
	switch (ev) {
		case "start":
			return from === "pending" ? "running" : "invalid";
		case "retry":
			return from === "running" ? "running" : "invalid";
		case "succeed":
			return from === "running" ? "succeeded" : "invalid";
		case "fail":
			return active ? "failed" : "invalid";
		case "supersede":
			return active ? "superseded" : "invalid";
	}
}

describe("operationNext", () => {
	it("allows exactly the S6 §6.3 transitions", () => {
		for (const from of OPERATION_STATES) {
			for (const ev of OPERATION_EVENTS) {
				expect(
					outcome(() => operationNext(from, ev)),
					`${from} --${ev}-->`,
				).toBe(expectedOperation(from, ev));
			}
		}
	});
});
