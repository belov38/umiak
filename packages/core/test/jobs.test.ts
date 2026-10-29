import { describe, expect, it } from "vitest";
import { QUEUE_NAMES, QUEUES, RecordingJobSender } from "../src/index.ts";

describe("QUEUES (S6 §15.1)", () => {
	it("lists every queue", () => {
		expect([...QUEUE_NAMES].sort()).toEqual(
			[
				"sandbox-op",
				"sandbox-op-dlq",
				"machine-op",
				"snapshot-op",
				"machine-events",
				"ctl-pool",
				"ctl-health",
				"ctl-autostop",
				"ctl-reconcile",
				"ctl-cleanup",
				"ctl-idp-sync",
			].sort(),
		);
		expect(Object.keys(QUEUES).sort()).toEqual([...QUEUE_NAMES].sort());
	});

	it("operation queues are singleton with heartbeat and backoff; sandbox-op dead-letters", () => {
		const op = {
			policy: "singleton",
			heartbeatSeconds: 30,
			expireInSeconds: 3600,
			retryLimit: 20,
			retryBackoff: true,
			retryDelay: 2,
			retryDelayMax: 120,
		};
		expect(QUEUES["sandbox-op"]).toEqual({
			...op,
			deadLetter: "sandbox-op-dlq",
		});
		expect(QUEUES["machine-op"]).toEqual(op);
		expect(QUEUES["snapshot-op"]).toEqual(op);
	});

	it("machine-events is stately; controllers are exclusive", () => {
		expect(QUEUES["machine-events"]).toEqual({
			policy: "stately",
			retryLimit: 10,
			retryBackoff: true,
		});
		for (const q of [
			"ctl-pool",
			"ctl-health",
			"ctl-autostop",
			"ctl-reconcile",
			"ctl-cleanup",
			"ctl-idp-sync",
		] as const) {
			expect(QUEUES[q].policy).toBe("exclusive");
		}
	});
});

describe("RecordingJobSender", () => {
	it("records queue, data and options in order", async () => {
		const jobs = new RecordingJobSender();
		const tx = {} as Parameters<RecordingJobSender["send"]>[0];
		await jobs.send(
			tx,
			"sandbox-op",
			{ operationId: "o1" },
			{
				singletonKey: "s1",
			},
		);
		await jobs.send(tx, "ctl-pool", {});
		expect(jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: "o1" },
				opts: { singletonKey: "s1" },
			},
			{ queue: "ctl-pool", data: {} },
		]);
	});
});
