import type { OperationState, SandboxState } from "./states.ts";

// Domain types of SandboxService: camelCase fields of the `runtime` rows (S6
// §5). Public ids, `origin` objects and endpoints are S7's mapping (S7 §8.1).
// Mappers take rows of `SELECT *` from node-postgres (timestamptz -> Date,
// jsonb -> parsed, bytea -> Buffer, bigint -> string).

export const OPERATION_KINDS = [
	"create",
	"fork",
	"stop",
	"resume",
	"recover",
	"delete",
	"save_snapshot",
	"reprovision",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export type SandboxOrigin = "template" | "snapshot" | "fork";
export type StopReason =
	| "user"
	| "ttl"
	| "idle"
	| "unexpected_shutdown"
	| "retention";

export interface Operation {
	id: string;
	sandboxId: string;
	kind: OperationKind;
	state: OperationState;
	/** Non-secret parameters of the request. */
	request: Record<string, unknown>;
	/** Last completed step. */
	step: string | null;
	progress: Record<string, unknown>;
	attempt: number;
	errorCode: string | null;
	errorMessage: string | null;
	retryable: boolean | null;
	requestedBy: string | null;
	requestedByKey: string | null;
	parentOperationId: string | null;
	supersededBy: string | null;
	/** Null for delete (S6 §7.9). */
	deadlineAt: Date | null;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	version: number;
}

export interface Sandbox {
	id: string;
	slug: string;
	teamId: string;
	createdBy: string | null;
	createdByKey: string | null;
	name: string | null;
	labels: Record<string, string>;
	templateSlug: string;
	sizeSlug: string;
	vcpu: number;
	memoryMb: number;
	templateBuildId: string;
	origin: SandboxOrigin;
	originSnapshotId: string | null;
	forkedFromSandboxId: string | null;
	providerId: string | null;
	nodeId: string | null;
	machineId: string | null;
	state: SandboxState;
	stopReason: StopReason | null;
	health: "ok" | "degraded";
	healthReason: string | null;
	degradedSince: Date | null;
	activity: "busy" | "idle" | "unknown";
	activityCounters: Record<string, number> | null;
	lastActivityAt: Date | null;
	lastApiCallAt: Date | null;
	ttlSeconds: number | null;
	deadlineAt: Date | null;
	idleTimeoutSeconds: number | null;
	lastRebootAt: Date | null;
	lastRebootReason: string | null;
	lastRecoverAt: Date | null;
	errorCode: string | null;
	errorMessage: string | null;
	listeningPorts: unknown;
	createdAt: Date;
	readyAt: Date | null;
	stoppedAt: Date | null;
	deletedAt: Date | null;
	stateChangedAt: Date;
	version: number;
	/** The pending/running operation, including internal `reprovision`. */
	activeOperation: Operation | null;
}

export type SnapshotKind = "auto" | "saved" | "fork_source";
export type SnapshotState =
	| "creating"
	| "ready"
	| "failed"
	| "deleting"
	| "deleted";

/** A row of `runtime.snapshots`; `kind = saved` for the saved-snapshot API. */
export interface SavedSnapshot {
	id: string;
	kind: SnapshotKind;
	teamId: string;
	name: string | null;
	pendingName: string | null;
	sourceSandboxId: string | null;
	sourceMachineId: string | null;
	consumerSandboxId: string | null;
	providerId: string;
	nodeId: string;
	storageId: string;
	templateBuildId: string;
	lvId: string;
	hw: Record<string, unknown> | null;
	consistency: "quiesced" | "crash" | "powered_off" | null;
	quiesceBroken: boolean;
	state: SnapshotState;
	createdAt: Date;
	readyAt: Date | null;
	deletedAt: Date | null;
	version: number;
}

export type CommandMode = "sync" | "stream" | "detached" | "pty";
export type CommandStatus =
	| "starting"
	| "running"
	| "exited"
	| "killed"
	| "timed_out"
	| "lost"
	| "failed_to_start";

export interface Command {
	id: string;
	sandboxId: string;
	machineId: string;
	cmd: string;
	cwd: string | null;
	/** Names only, never values. */
	envKeys: string[];
	mode: CommandMode;
	timeoutSeconds: number | null;
	status: CommandStatus;
	exitCode: number | null;
	signal: string | null;
	stdoutBytes: number | null;
	stderrBytes: number | null;
	bootId: string | null;
	createdBy: string | null;
	requestId: string | null;
	createdAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
}

export type PortMode = "token" | "sso" | "public";

export interface HostedPort {
	id: string;
	sandboxId: string;
	port: number;
	/** `<slug>-<port>`. */
	label: string;
	mode: PortMode;
	tokenHash: Buffer | null;
	authEpoch: number;
	createdAt: Date;
	deletedAt: Date | null;
}

export interface Page<T> {
	data: T[];
	/** Opaque; null on the last page. */
	nextCursor: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: rows of node-postgres are untyped
type Row = Record<string, any>;

const num = (v: unknown): number | null =>
	v === null || v === undefined ? null : Number(v);

export function operationFromRow(r: Row): Operation {
	return {
		id: r.id,
		sandboxId: r.sandbox_id,
		kind: r.kind,
		state: r.state,
		request: r.request ?? {},
		step: r.step,
		progress: r.progress ?? {},
		attempt: r.attempt,
		errorCode: r.error_code,
		errorMessage: r.error_message,
		retryable: r.retryable,
		requestedBy: r.requested_by,
		requestedByKey: r.requested_by_key,
		parentOperationId: r.parent_operation_id,
		supersededBy: r.superseded_by,
		deadlineAt: r.deadline_at,
		createdAt: r.created_at,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
		version: r.version,
	};
}

export function sandboxFromRow(
	r: Row,
	activeOperation: Operation | null,
): Sandbox {
	return {
		id: r.id,
		slug: r.slug,
		teamId: r.team_id,
		createdBy: r.created_by,
		createdByKey: r.created_by_key,
		name: r.name,
		labels: r.labels ?? {},
		templateSlug: r.template_slug,
		sizeSlug: r.size_slug,
		vcpu: r.vcpu,
		memoryMb: r.memory_mb,
		templateBuildId: r.template_build_id,
		origin: r.origin,
		originSnapshotId: r.origin_snapshot_id,
		forkedFromSandboxId: r.forked_from_sandbox_id,
		providerId: r.provider_id,
		nodeId: r.node_id,
		machineId: r.machine_id,
		state: r.state,
		stopReason: r.stop_reason,
		health: r.health,
		healthReason: r.health_reason,
		degradedSince: r.degraded_since,
		activity: r.activity,
		activityCounters: r.activity_counters,
		lastActivityAt: r.last_activity_at,
		lastApiCallAt: r.last_api_call_at,
		ttlSeconds: r.ttl_seconds,
		deadlineAt: r.deadline_at,
		idleTimeoutSeconds: r.idle_timeout_seconds,
		lastRebootAt: r.last_reboot_at,
		lastRebootReason: r.last_reboot_reason,
		lastRecoverAt: r.last_recover_at,
		errorCode: r.error_code,
		errorMessage: r.error_message,
		listeningPorts: r.listening_ports,
		createdAt: r.created_at,
		readyAt: r.ready_at,
		stoppedAt: r.stopped_at,
		deletedAt: r.deleted_at,
		stateChangedAt: r.state_changed_at,
		version: r.version,
		activeOperation,
	};
}

export function snapshotFromRow(r: Row): SavedSnapshot {
	return {
		id: r.id,
		kind: r.kind,
		teamId: r.team_id,
		name: r.name,
		pendingName: r.pending_name,
		sourceSandboxId: r.source_sandbox_id,
		sourceMachineId: r.source_machine_id,
		consumerSandboxId: r.consumer_sandbox_id,
		providerId: r.provider_id,
		nodeId: r.node_id,
		storageId: r.storage_id,
		templateBuildId: r.template_build_id,
		lvId: r.lv_id,
		hw: r.hw,
		consistency: r.consistency,
		quiesceBroken: r.quiesce_broken,
		state: r.state,
		createdAt: r.created_at,
		readyAt: r.ready_at,
		deletedAt: r.deleted_at,
		version: r.version,
	};
}

export function commandFromRow(r: Row): Command {
	return {
		id: r.id,
		sandboxId: r.sandbox_id,
		machineId: r.machine_id,
		cmd: r.cmd,
		cwd: r.cwd,
		envKeys: r.env_keys ?? [],
		mode: r.mode,
		timeoutSeconds: r.timeout_seconds,
		status: r.status,
		exitCode: r.exit_code,
		signal: r.signal,
		stdoutBytes: num(r.stdout_bytes),
		stderrBytes: num(r.stderr_bytes),
		bootId: r.boot_id,
		createdBy: r.created_by,
		requestId: r.request_id,
		createdAt: r.created_at,
		startedAt: r.started_at,
		endedAt: r.ended_at,
	};
}

export function hostedPortFromRow(r: Row): HostedPort {
	return {
		id: r.id,
		sandboxId: r.sandbox_id,
		port: r.port,
		label: r.label,
		mode: r.mode,
		tokenHash: r.token_hash,
		authEpoch: r.auth_epoch,
		createdAt: r.created_at,
		deletedAt: r.deleted_at,
	};
}
