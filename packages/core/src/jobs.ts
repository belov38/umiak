import type { Tx } from "@sbx/db";
import type { QueueName } from "./queues.ts";

export interface JobSendOptions {
	singletonKey?: string;
	/** Seconds from now. */
	startAfter?: number;
}

/**
 * Enqueues a job inside the caller's transaction: the job exists only if the
 * transaction commits. Job data carries ids only, never secrets.
 */
export interface JobSender {
	send(
		tx: Tx,
		queue: QueueName,
		data: Record<string, unknown>,
		opts?: JobSendOptions,
	): Promise<void>;
}

export interface SentJob {
	queue: QueueName;
	data: Record<string, unknown>;
	opts?: JobSendOptions;
}

/** Test double: records every send, including sends of rolled-back transactions. */
export class RecordingJobSender implements JobSender {
	readonly sent: SentJob[] = [];

	async send(
		_tx: Tx,
		queue: QueueName,
		data: Record<string, unknown>,
		opts?: JobSendOptions,
	): Promise<void> {
		this.sent.push(
			opts === undefined ? { queue, data } : { queue, data, opts },
		);
	}

	clear(): void {
		this.sent.length = 0;
	}
}
