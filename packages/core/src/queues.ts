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
	// Key: machineId, data {machineId, action: provision | delete}.
	"machine-op": { policy: "singleton", ...OPERATION_RETRIES },
	// Key: snapshotId, data {snapshotId, action: delete}.
	"snapshot-op": { policy: "singleton", ...OPERATION_RETRIES },
	// Key: machineId, data {machineId}.
	"machine-events": { policy: "stately", retryLimit: 10, retryBackoff: true },
	"ctl-pool": CONTROLLER,
	"ctl-health": CONTROLLER,
	"ctl-autostop": CONTROLLER,
	"ctl-reconcile": CONTROLLER,
	"ctl-cleanup": CONTROLLER,
	"ctl-idp-sync": CONTROLLER,
} as const satisfies Record<QueueName, QueueOptions>;
