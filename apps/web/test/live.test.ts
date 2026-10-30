// Live state of the sandbox page (S8 §9.6): one long-poll at a time, for
// every state but the current one; operations started by a button are
// awaited in the same loop; the loop ends on its AbortSignal.
import { describe, expect, it } from "vitest";
import {
	liveWaitFor,
	SANDBOX_STATES,
	startLiveLoop,
	waitForStates,
} from "@/features/sandbox/live";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function until(cond: () => boolean, rounds = 200) {
	for (let i = 0; i < rounds && !cond(); i++) await tick();
	expect(cond()).toBe(true);
}

/** A promise that settles when the signal aborts (like a real long-poll). */
function hang(signal: AbortSignal): Promise<never> {
	return new Promise((_r, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

describe("waitFor", () => {
	it("is every state except the current one", () => {
		for (const s of SANDBOX_STATES) {
			const w = waitForStates(s);
			expect(w).not.toContain(s);
			expect(w).toHaveLength(SANDBOX_STATES.length - 1);
		}
		expect(liveWaitFor("ready")).toBe(
			"creating,stopping,stopped,starting,error,deleting,deleted",
		);
		expect(liveWaitFor("stopped")?.split(",")).toContain("starting");
	});

	it("is null where the api answers at once (error, deleting, deleted) or before the first read", () => {
		expect(liveWaitFor("error")).toBe(null);
		expect(liveWaitFor("deleting")).toBe(null);
		expect(liveWaitFor("deleted")).toBe(null);
		expect(liveWaitFor(undefined)).toBe(null);
	});

	it("an unknown state waits for every known one", () => {
		expect(liveWaitFor("hibernating")?.split(",")).toEqual([...SANDBOX_STATES]);
	});
});

describe("startLiveLoop", () => {
	it("long-polls with waitFor of the current state, one at a time", async () => {
		let state = "starting";
		const polls: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => state,
				longPoll: async (waitFor) => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					polls.push(waitFor);
					await tick();
					state = "ready";
					inFlight--;
				},
				waitOperation: async () => {},
				sleep: () => tick(),
			},
			ac.signal,
		);
		await until(() => polls.length >= 3);
		ac.abort();
		await loop.done;
		expect(polls[0]).toBe(waitForStates("starting").join(","));
		expect(polls[1]).toBe(waitForStates("ready").join(","));
		expect(maxInFlight).toBe(1);
	});

	it("stops on abort, also in the middle of a long-poll", async () => {
		let polls = 0;
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: (_w, signal) => {
					polls++;
					return hang(signal);
				},
				waitOperation: async () => {},
			},
			ac.signal,
		);
		await until(() => polls === 1);
		ac.abort();
		await loop.done;
		await tick();
		expect(polls).toBe(1);
	});

	it("does not start when the signal is already aborted", async () => {
		let polls = 0;
		const ac = new AbortController();
		ac.abort();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: async () => {
					polls++;
				},
				waitOperation: async () => {},
			},
			ac.signal,
		);
		await loop.done;
		expect(polls).toBe(0);
	});

	it("sleeps instead of polling in an end state", async () => {
		let polls = 0;
		let sleeps = 0;
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "error",
				longPoll: async () => {
					polls++;
				},
				waitOperation: async () => {},
				sleep: async () => {
					sleeps++;
					await tick();
				},
			},
			ac.signal,
		);
		await until(() => sleeps >= 3);
		ac.abort();
		await loop.done;
		expect(polls).toBe(0);
	});

	it("a tracked operation interrupts the long-poll and is awaited next", async () => {
		const events: string[] = [];
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: (_w, signal) => {
					events.push("poll");
					return hang(signal);
				},
				waitOperation: async (id) => {
					events.push(`op:${id}`);
				},
			},
			ac.signal,
		);
		await until(() => events.length === 1);
		loop.track("op_1");
		await until(() => events.length >= 3);
		ac.abort();
		await loop.done;
		expect(events.slice(0, 3)).toEqual(["poll", "op:op_1", "poll"]);
	});

	it("a failed operation wait is dropped after the error is reported", async () => {
		const errors: unknown[] = [];
		const ops: string[] = [];
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: (_w, signal) => hang(signal),
				waitOperation: async (id) => {
					ops.push(id);
					throw new Error("gone");
				},
				onError: (e) => errors.push(e),
				sleep: () => tick(),
			},
			ac.signal,
		);
		loop.track("op_1");
		await until(() => errors.length === 1);
		await tick();
		ac.abort();
		await loop.done;
		expect(ops).toEqual(["op_1"]);
	});

	it("backs off after a failed long-poll and goes on", async () => {
		let polls = 0;
		const sleeps: number[] = [];
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: async () => {
					polls++;
					await tick();
					if (polls === 1) throw new Error("network");
				},
				waitOperation: async () => {},
				sleep: async (ms) => {
					sleeps.push(ms);
					await tick();
				},
				errorMs: 1234,
			},
			ac.signal,
		);
		await until(() => polls >= 3);
		ac.abort();
		await loop.done;
		expect(sleeps[0]).toBe(1234);
	});

	it("pauses after a long-poll that answered at once", async () => {
		let polls = 0;
		const sleeps: number[] = [];
		const ac = new AbortController();
		const loop = startLiveLoop(
			{
				state: () => "ready",
				longPoll: async () => {
					polls++;
				},
				waitOperation: async () => {},
				sleep: async (ms) => {
					sleeps.push(ms);
					await tick();
				},
				minRoundMs: 500,
			},
			ac.signal,
		);
		await until(() => polls >= 2);
		ac.abort();
		await loop.done;
		expect(sleeps[0]).toBeGreaterThan(400);
		expect(sleeps[0]).toBeLessThanOrEqual(500);
	});
});
