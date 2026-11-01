import type { Tx } from "@umiak/db";
import type { PgBoss, SendOptions } from "pg-boss";
import type { QueueName } from "./queues.ts";

export interface JobSendOptions {
	singletonKey?: string;
	/** Seconds from now. */
	startAfter?: number;
	/** Overrides the queue's retry limit (delete jobs: DELETE_RETRY_LIMIT). */
	retryLimit?: number;
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

/**
 * pg-boss sender (decision 7): the job is inserted through the caller's
 * transaction client, so it exists only if that transaction commits. Retry,
 * expiry, heartbeat and dead-letter settings come from the queue (created by
 * `ensureQueues`); only the per-job overrides are passed. The queue cache of
 * pg-boss needs `boss.start()` before the first send.
 */
export class PgBossJobSender implements JobSender {
	readonly #boss: PgBoss;

	constructor(boss: PgBoss) {
		this.#boss = boss;
	}

	async send(
		tx: Tx,
		queue: QueueName,
		data: Record<string, unknown>,
		opts: JobSendOptions = {},
	): Promise<void> {
		const options: SendOptions = {
			db: {
				executeSql: (text: string, values?: unknown[]) =>
					tx.client.query(text, values),
			},
		};
		if (opts.singletonKey !== undefined)
			options.singletonKey = opts.singletonKey;
		if (opts.startAfter !== undefined) options.startAfter = opts.startAfter;
		if (opts.retryLimit !== undefined) options.retryLimit = opts.retryLimit;
		// null: a singleton/exclusive policy kept an existing job; nothing to do.
		await this.#boss.send(queue, data, options);
	}
}
