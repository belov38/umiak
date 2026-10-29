import {
	agentEvents,
	agentSyntheticEvents,
	commands,
	disks,
	hostedPorts,
	idempotencyKeys,
	machines,
	nodeCloneSlots,
	nodes,
	operations,
	providers,
	reconcileSeen,
	sandboxEvents,
	sandboxes,
	sandboxSecrets,
	snapshots,
	storages,
	templateBuilds,
	vmidLeases,
} from "./runtime.ts";
import {
	gatewayInstances,
	tunnelCredentials,
	tunnelSessions,
} from "./tunnel.ts";

export * from "./runtime.ts";
export * from "./tunnel.ts";

/** Every table of schemas `runtime` and `tunnel`, for drizzle(..., { schema }). */
export const schema = {
	providers,
	nodes,
	storages,
	templateBuilds,
	vmidLeases,
	machines,
	disks,
	snapshots,
	sandboxes,
	sandboxSecrets,
	sandboxEvents,
	operations,
	idempotencyKeys,
	commands,
	hostedPorts,
	agentEvents,
	agentSyntheticEvents,
	nodeCloneSlots,
	reconcileSeen,
	gatewayInstances,
	tunnelSessions,
	tunnelCredentials,
};
