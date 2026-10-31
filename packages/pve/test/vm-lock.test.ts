import { describe, expect, it } from "vitest";
import { PveTaskError, retryOnVmLock } from "../src/index.ts";

const lockErr = () =>
	new PveTaskError(
		"UPID:pve:1:qmstop:501",
		"can't lock file '/var/lock/qemu-server/lock-501.conf' - got timeout",
	);

describe("retryOnVmLock", () => {
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
