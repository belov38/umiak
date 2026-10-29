import type { SecretFile } from "@sbx/core";
import type { DiskSlot, QuiesceHook } from "@sbx/pve";

// Infrastructure ports of the worker. Handlers reach Proxmox, the guest agent
// and the gateway only through these interfaces; tests use the fakes in
// test/fakes, production the adapters of Task 13.

/** One disk of a VM or a snapshot, mirrored into `runtime.disks`. */
export interface InfraDisk {
	slot: DiskSlot;
	/** Proxmox volume id or LV name. */
	volume: string;
	sizeBytes?: number;
	options: Record<string, string>;
}

/** A snapshot as S1 needs it for fork and delete (built from `snapshots` + `disks`). */
export interface InfraSnapshotRef {
	/** Snapshot id in LV names: the snapshot UUID without dashes (decision 2). */
	lvId: string;
	sourceVmid: number;
	disks: InfraDisk[];
	hw: Record<string, string>;
}

export interface InfraSize {
	vcpu: number;
	memoryMb: number;
}

/** SMBIOS identity (S2 §5.2). `serial` carries the bootstrap secret: never log it. */
export interface InfraSmbios {
	uuid: string;
	serial: string;
}

export interface CreatedVm {
	vmid: number;
	mac: string;
	disks: InfraDisk[];
}

export type VmStatus = "running" | "stopped" | "paused" | "missing";

export interface InfraVm {
	vmid: number;
	status: VmStatus;
	pool?: string;
	tags: string[];
}

export interface InfraLv {
	name: string;
	tags: string[];
}

export interface InfraSnapshotResult {
	disks: InfraDisk[];
	hw: Record<string, string>;
	consistency: "quiesced" | "powered_off";
}

/**
 * S1 primitives of one node. `create` and `fork` allocate the VMID/MAC lease
 * with `machineId` as owner (idempotent per machine, S6 §5.3); `delete`
 * verifies that no traces remain and frees the lease, and tolerates a missing
 * VM.
 */
export interface NodeInfra {
	readonly vmidRange: { min: number; max: number };
	readonly templateVmids: number[];
	create(p: {
		machineId: string;
		templateVmid: number;
		size: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm>;
	fork(p: {
		machineId: string;
		snapshot: InfraSnapshotRef;
		size?: InfraSize;
		smbios: InfraSmbios;
	}): Promise<CreatedVm>;
	start(vmid: number): Promise<void>;
	shutdown(vmid: number, timeoutS: number): Promise<"stopped" | "timeout">;
	stop(vmid: number): Promise<void>;
	status(vmid: number): Promise<VmStatus>;
	configure(vmid: number, size: InfraSize): Promise<void>;
	delete(vmid: number): Promise<void>;
	/** The machine's VMID lease (`vmid_leases.machine_id`); a non-releasing one first. */
	leaseOf(
		machineId: string,
	): Promise<{ vmid: number; mac: string } | undefined>;
	snapshot(
		vmid: number,
		opts: { lvId: string; hook?: QuiesceHook },
	): Promise<InfraSnapshotResult>;
	deleteSnapshot(ref: InfraSnapshotRef): Promise<void>;
	listVms(): Promise<InfraVm[]>;
	listLvs(): Promise<InfraLv[]>;
	removeLvs(names: string[]): Promise<void>;
	qgaPing(vmid: number): Promise<boolean>;
	qgaExec(vmid: number, argv: string[]): Promise<{ exitCode: number }>;
}

export interface InfraRegistry {
	forNode(nodeId: string): Promise<NodeInfra>;
}

/** `System/Claim` (S3 §8.1) as S6 sends it. Secret fields: never log. */
export interface ClaimRequest {
	reason: "claim";
	sandboxId: string;
	hostname: string;
	env: Record<string, string>;
	secretEnv: Record<string, string>;
	secretFiles: SecretFile[];
	authorizedKeys: string[];
}

export interface AgentActivity {
	runningCommands: number;
	openPtys: number;
	tcpStreams: number;
}

/**
 * Guest agent RPC (S3) through the gateway. Mutating calls carry a
 * deterministic `requestId` (S6 §7.1 p. 4). Errors: `AgentUnavailable`
 * (retryable) and `AgentRejected` (permanent). An agent restart goes through
 * `NodeInfra.qgaExec`.
 */
export interface AgentPort {
	claim(machineId: string, req: ClaimRequest, requestId: string): Promise<void>;
	updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<void>;
	updateSecrets(
		machineId: string,
		secrets: { secretEnv: Record<string, string>; secretFiles: SecretFile[] },
		requestId: string,
	): Promise<void>;
	prepareStop(machineId: string): Promise<void>;
	quiesceHook(machineId: string, leaseMs: number): QuiesceHook;
	activity(machineId: string): Promise<AgentActivity>;
}

/** Gateway internal API (S2 §5.2). */
export interface GatewayPort {
	rotateToken(machineId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Port errors. `retryable` is what the step engine looks at: a retryable error
// is rethrown so pg-boss repeats the job; anything else is permanent.

export class AgentUnavailable extends Error {
	readonly retryable = true;
	readonly code = "agent_unavailable";
	constructor(message = "agent unavailable", opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "AgentUnavailable";
	}
}

export class AgentRejected extends Error {
	readonly retryable = false;
	/** Agent error code (S3 §19), e.g. `already_claimed`. */
	readonly code: string;
	constructor(code: string, message = `agent rejected the call: ${code}`) {
		super(message);
		this.name = "AgentRejected";
		this.code = code;
	}
}

export class GatewayUnavailable extends Error {
	readonly retryable = true;
	readonly code = "gateway_unavailable";
	constructor(message = "gateway unavailable", opts?: { cause?: unknown }) {
		super(message, opts);
		this.name = "GatewayUnavailable";
	}
}

export class GatewayRejected extends Error {
	readonly retryable = false;
	readonly code: string;
	constructor(code: string, message = `gateway rejected the call: ${code}`) {
		super(message);
		this.name = "GatewayRejected";
		this.code = code;
	}
}

/** True for errors that should make pg-boss repeat the job (`retryable === true`). */
export function isRetryable(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as { retryable?: unknown }).retryable === true
	);
}
