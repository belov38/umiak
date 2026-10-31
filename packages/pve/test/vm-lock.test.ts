import { describe, expect, it } from "vitest";
import { PveTaskError, retryOnVmLock, ThawFailedError } from "../src/index.ts";

const lockErr = () =>
	new PveTaskError(
		"UPID:pve:1:qmstop:501",
		"can't lock file '/var/lock/qemu-server/lock-501.conf' - got timeout",
	);

describe("retryOnVmLock", () => {
	it("does not repeat a snapshot when thaw failed and emergency stop hit the VM lock", async () => {
		const error = new Error(
			"thaw failed; hard stop also failed: can't lock file 'vm' - got timeout",
			{ cause: new ThawFailedError(501, new Error("QGA unavailable")) },
		);
		let calls = 0;
		await expect(
			retryOnVmLock(
				async () => {
					calls++;
					throw error;
				},
				{ retryFreezeBudget: true, sleep: async () => {} },
			),
		).rejects.toBe(error);
		expect(calls).toBe(1);
	});
	it("covers the qmeventd 30 second cleanup window by default", async () => {
		let elapsed = 0;
		let calls = 0;
		await retryOnVmLock(
			async () => {
				calls++;
				if (elapsed <= 30_000) throw lockErr();
			},
			{
				sleep: async (ms) => {
					elapsed += ms;
				},
			},
		);
		expect(calls).toBe(5);
		expect(elapsed).toBe(40_000);
	});

	it("optionally retries the freeze budget exhausted while waiting on the VM lock", async () => {
		let calls = 0;
		await retryOnVmLock(
			async () => {
				if (++calls === 1)
					throw new Error(
						"freeze took 12000 ms (budget 1000 ms); snapshot discarded",
					);
			},
			{ retryFreezeBudget: true, sleep: async () => {} },
		);
		expect(calls).toBe(2);
	});
	it("retries a task that timed out on the VM lock", async () => {
		const slept: number[] = [];
		let calls = 0;
		const r = await retryOnVmLock(
			async () => {
				if (++calls < 3) throw lockErr();
				return "ok";
			},
			{ sleep: async (ms) => void slept.push(ms) },
		);
		expect(r).toBe("ok");
		expect(slept).toEqual([10_000, 10_000]);
	});

	it("gives up after the last attempt", async () => {
		let calls = 0;
		await expect(
			retryOnVmLock(
				async () => {
					calls++;
					throw lockErr();
				},
				{ tries: 3, sleep: async () => {} },
			),
		).rejects.toThrow(/can't lock file/);
		expect(calls).toBe(3);
	});

	it("does not retry other errors", async () => {
		let calls = 0;
		await expect(
			retryOnVmLock(
				async () => {
					calls++;
					throw new Error("VM 501 not running");
				},
				{ sleep: async () => {} },
			),
		).rejects.toThrow(/not running/);
		expect(calls).toBe(1);
	});
});
