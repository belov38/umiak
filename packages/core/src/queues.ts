import type { PgBoss } from "pg-boss";

// pg-boss queues of the worker (S6 §15.1, decision 15). Plain option objects
// whose keys match pg-boss `Queue` options; `ensureQueues(boss)` creates them.

export const QUEUE_NAMES = [
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
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueueOptions {
	policy: "standard" | "singleton" | "stately" | "exclusive";
	heartbeatSeconds?: number;
	expireInSeconds?: number;
	retryLimit?: number;
	retryBackoff?: boolean;
	retryDelay?: number;
	retryDelayMax?: number;
	deadLetter?: QueueName;
}

// Operation-style jobs: long steps with heartbeat, exponential retries.
const OPERATION_RETRIES = {
	heartbeatSeconds: 30,
	expireInSeconds: 3600,
	retryLimit: 20,
	retryBackoff: true,
	retryDelay: 2,
	retryDelayMax: 120,
} as const;

/**
 * Retry limit for delete jobs: effectively unlimited. S6 §15.1: a delete never
 * gives up and has no dead letter (alert via `sbx_delete_stuck`). Used as the
 * `snapshot-op` queue limit (delete-only) and passed per job on every
 * `machine-op` delete send. `sandbox-op` delete jobs must also be sent with
 * `retryLimit: DELETE_RETRY_LIMIT` (otherwise they reach `sandbox-op-dlq`).
 */
export const DELETE_RETRY_LIMIT = 1_000_000;

const CONTROLLER = { policy: "exclusive" } as const;

export const QUEUES = {
	// Key: sandboxId, data {operationId}.
	"sandbox-op": {
		policy: "singleton",
		...OPERATION_RETRIES,
		deadLetter: "sandbox-op-dlq",
	},
	// Exhausted sandbox-op jobs (decision 8). Handling is idempotent, so no
	// singleton; it is retried like an operation job.
	"sandbox-op-dlq": { policy: "standard", ...OPERATION_RETRIES },
	// Key: machineId, data {machineId, action: provision | delete}. The limit
	// of 20 applies to provision; delete sends pass DELETE_RETRY_LIMIT.
	"machine-op": { policy: "singleton", ...OPERATION_RETRIES },
	// Key: snapshotId, data {snapshotId, action: delete}. Delete-only.
	"snapshot-op": {
		policy: "singleton",
		...OPERATION_RETRIES,
		retryLimit: DELETE_RETRY_LIMIT,
	},
	// Key: machineId, data {machineId}.
	"machine-events": { policy: "stately", retryLimit: 10, retryBackoff: true },
	"ctl-pool": CONTROLLER,
	"ctl-health": CONTROLLER,
	"ctl-autostop": CONTROLLER,
	"ctl-reconcile": CONTROLLER,
	"ctl-cleanup": CONTROLLER,
	"ctl-idp-sync": CONTROLLER,
} as const satisfies Record<QueueName, QueueOptions>;

/** Dead-letter targets first: pg-boss requires them to exist. */
function creationOrder(): QueueName[] {
	const dlq = new Set<QueueName>();
	for (const name of QUEUE_NAMES) {
		const target = (QUEUES[name] as QueueOptions).deadLetter;
		if (target !== undefined) dlq.add(target);
	}
	return [...dlq, ...QUEUE_NAMES.filter((n) => !dlq.has(n))];
}

/**
 * Creates the queues of §15.1, or brings the options of existing ones back to
 * `QUEUES`. A policy cannot change in place: a queue with another policy is an
 * error (it needs a manual migration).
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
	for (const name of creationOrder()) {
		const opts: QueueOptions = QUEUES[name];
		const { policy, ...rest } = opts;
		const existing = await boss.getQueue(name);
		if (existing === null) {
			await boss.createQueue(name, { policy, ...rest });
			continue;
		}
		if (existing.policy !== policy) {
			throw new Error(
				`ensureQueues: queue ${name} has policy ${existing.policy}, expected ${policy}`,
			);
		}
		await boss.updateQueue(name, {
			...rest,
			deadLetter: opts.deadLetter ?? null,
			retryDelayMax: opts.retryDelayMax ?? null,
			heartbeatSeconds: opts.heartbeatSeconds ?? null,
		});
	}
}
