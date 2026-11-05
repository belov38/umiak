import { describe, expect, it } from "vitest";
import {
	DELETE_RETRY_LIMIT,
	QUEUE_NAMES,
	QUEUES,
	type QueueOptions,
	RecordingJobSender,
} from "../src/index.ts";

describe("QUEUES (S6 §15.1)", () => {
	it("lists every queue", () => {
		expect([...QUEUE_NAMES].sort()).toEqual(
			[
				"sandbox-op",
				"sandbox-op-dlq",
				"machine-op",
				"snapshot-op",
				"machine-events",
				"ctl-health",
				"ctl-autostop",
				"ctl-reconcile",
				"ctl-start-queue",
				"ctl-cleanup",
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
		// snapshot-op only deletes: retries without limit, no dead letter (§15.1).
		expect(QUEUES["snapshot-op"]).toEqual({
			...op,
			retryLimit: DELETE_RETRY_LIMIT,
		});
		expect(DELETE_RETRY_LIMIT).toBeGreaterThanOrEqual(1_000_000);
	});

	it("every queue has a heartbeat and an expiry (a dead pod's job comes back)", () => {
		for (const name of QUEUE_NAMES) {
			const q: QueueOptions = QUEUES[name];
			expect(q.heartbeatSeconds, name).toBe(30);
			expect(q.expireInSeconds, name).toBeGreaterThan(q.heartbeatSeconds ?? 0);
		}
	});

	it("machine-events is stately; controllers are exclusive", () => {
		expect(QUEUES["machine-events"]).toEqual({
			policy: "stately",
			heartbeatSeconds: 30,
			expireInSeconds: 300,
			retryLimit: 10,
			retryBackoff: true,
		});
		for (const q of [
			"ctl-health",
			"ctl-autostop",
			"ctl-reconcile",
			"ctl-start-queue",
			"ctl-cleanup",
		] as const) {
			expect(QUEUES[q].policy).toBe("exclusive");
			// A pod that dies mid-run must not block the queue until expiry.
			expect(QUEUES[q].heartbeatSeconds).toBe(30);
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
				retryLimit: DELETE_RETRY_LIMIT,
			},
		);
		await jobs.send(tx, "ctl-health", {});
		expect(jobs.sent).toEqual([
			{
				queue: "sandbox-op",
				data: { operationId: "o1" },
				opts: { singletonKey: "s1", retryLimit: DELETE_RETRY_LIMIT },
			},
			{ queue: "ctl-health", data: {} },
		]);
	});
});
