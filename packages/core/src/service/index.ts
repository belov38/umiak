import type { Principal } from "../principal.ts";
import type {
	Command,
	HostedPort,
	Operation,
	Page,
	PortMode,
	Sandbox,
	SavedSnapshot,
} from "../rows.ts";
import type { SecretPatch, SecretSets } from "../secrets.ts";
import type { SandboxState } from "../states.ts";
import {
	type AgentTarget,
	type CommandListFilter,
	type CommandResult,
	type CommandSpec,
	completeCommand,
	createCommand,
	createCommandWithKey,
	failCommandStart,
	getCommand,
	listCommands,
	markCommandRunning,
	resolveAgentTarget,
	touchApiActivity,
} from "./commands.ts";
import type { SandboxServiceDeps } from "./common.ts";
import {
	type CreateInput,
	type CreateOptions,
	type CreateResult,
	createSandbox,
} from "./create.ts";
import { deleteSandbox } from "./delete.ts";
import {
	type EnvReplaceInput,
	type EnvUpdateResult,
	getEnv,
	patchEnv,
	replaceEnv,
} from "./env.ts";
import { type ForkInput, type ForkResult, forkSandbox } from "./fork.ts";
import {
	type ResumeInput,
	recoverSandbox,
	resumeSandbox,
	stopSandbox,
} from "./lifecycle.ts";
import {
	type HostPortOptions,
	type HostPortResult,
	hostPort,
	listHostedPorts,
	rotatePortToken,
	unhostPort,
} from "./ports.ts";
import {
	extendSandbox,
	getOperation,
	getSandbox,
	type ListFilter,
	listSandboxes,
	type UpdateInput,
	updateSandbox,
	waitForOperation,
	waitForSandboxState,
} from "./read.ts";
import { renameSandbox } from "./rename.ts";
import {
	deleteSavedSnapshot,
	getSavedSnapshot,
	listSavedSnapshots,
	type SaveSnapshotResult,
	saveSnapshot,
} from "./snapshots.ts";

export {
	type AgentTarget,
	API_ACTIVITY_THROTTLE_SECONDS,
	COMMAND_CMD_MAX_BYTES,
	COMMAND_DEFAULT_USER,
	COMMAND_MODES,
	COMMAND_SCOPE,
	type CommandListFilter,
	type CommandResult,
	type CommandSpec,
	completeCommand,
	failCommandStart,
	markCommandRunning,
	markOutputTruncated,
	TERMINAL_COMMAND_STATUSES,
	truncateUtf8,
} from "./commands.ts";
export type { SandboxServiceDeps, ServiceLogger } from "./common.ts";
export {
	findSandboxRow,
	insertOperation,
	insertSandboxEvent,
	isUuid,
	loadOperation,
	loadSandbox,
	type NewOperation,
	type NewSandboxEvent,
	type Queryable,
	type SandboxRow,
	toSandbox,
} from "./common.ts";
export {
	CREATE_SCOPE,
	type CreateInput,
	type CreateOptions,
	type CreateResult,
	OUT_OF_CAPACITY_RETRY_SECONDS,
	POOL_EXHAUSTED_RETRY_SECONDS,
} from "./create.ts";
export {
	admitCold,
	claimWarm,
	type Placement,
} from "./create-placement.ts";
export { decodeCursor, encodeCursor } from "./cursor.ts";
export { requestSystemDelete } from "./delete.ts";
export type { EnvReplaceInput, EnvUpdateResult } from "./env.ts";
export { FORK_SCOPE, type ForkInput, type ForkResult } from "./fork.ts";
export {
	RESUME_SCOPE,
	type ResumeInput,
	requestStop,
	requestSystemResume,
	type StopRequestReason,
	type SystemResumeResult,
} from "./lifecycle.ts";
export {
	type HostPortOptions,
	type HostPortResult,
	MAX_HOSTED_PORTS,
	PORT_APP_PROTOCOLS,
	PORT_HOST_REWRITES,
	PORT_MODES,
	PORT_TOKEN_PREFIX,
	RESERVED_PORTS,
} from "./ports.ts";
export type { ListFilter, UpdateInput } from "./read.ts";
export { type SaveSnapshotResult, SNAPSHOT_SCOPE } from "./snapshots.ts";

/**
 * Service layer of S7 (S6 §14.1). Ids are UUIDs (S7 encodes public ids); a
 * sandbox may also be addressed by slug. Another team's resources are
 * `not_found`.
 */
export interface SandboxService {
	/** `opts`: the api's hash body and environment sets (CreateOptions). */
	create(
		p: Principal,
		input: CreateInput,
		idemKey?: string,
		opts?: CreateOptions,
	): Promise<CreateResult>;
	get(p: Principal, idOrSlug: string): Promise<Sandbox>;
	list(
		p: Principal,
		filter?: ListFilter,
		cursor?: string,
	): Promise<Page<Sandbox>>;
	update(p: Principal, idOrSlug: string, patch: UpdateInput): Promise<Sandbox>;
	extend(p: Principal, idOrSlug: string, ttlSeconds?: number): Promise<Sandbox>;
	delete(p: Principal, idOrSlug: string): Promise<Operation>;
	/** From `ready`; returns the active stop on a repeat. */
	stop(p: Principal, idOrSlug: string): Promise<Operation>;
	/** Same body while a resume is active returns it; another body is `operation_in_progress`. */
	resume(
		p: Principal,
		idOrSlug: string,
		input?: ResumeInput,
	): Promise<Operation>;
	fork(
		p: Principal,
		idOrSlug: string,
		input: ForkInput,
		idemKey?: string,
	): Promise<ForkResult>;
	recover(p: Principal, idOrSlug: string): Promise<Operation>;
	saveSnapshot(
		p: Principal,
		idOrSlug: string,
		name: string,
		idemKey?: string,
	): Promise<SaveSnapshotResult>;
	deleteSavedSnapshot(
		p: Principal,
		name: string,
		expectedId?: string,
	): Promise<void>;
	/** `ready`, `creating` and `failed` of the last day. */
	listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]>;
	/** `ready` by name, else `creating` by pending name, else `snapshot_not_found`. */
	getSavedSnapshot(p: Principal, name: string): Promise<SavedSnapshot>;
	getOperation(p: Principal, id: string): Promise<Operation>;
	/** No access check: the caller has read the sandbox with `get` first. */
	/** `signal` aborts the wait: it rejects with the abort reason. */
	waitForState(
		id: string,
		states: SandboxState[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Sandbox>;
	/** Until terminal or `timeoutMs`; no access check (read it with `getOperation` first). */
	waitForOperation(id: string, timeoutMs: number): Promise<Operation>;
	/** Slug change with new port labels and `authEpoch + 1` (S7 §5.4). */
	rename(p: Principal, idOrSlug: string, slug: string): Promise<Sandbox>;
	getEnv(p: Principal, idOrSlug: string): Promise<SecretSets>;
	/** Each given set replaces its set whole (`PUT /env`). */
	replaceEnv(
		p: Principal,
		idOrSlug: string,
		input: EnvReplaceInput,
	): Promise<EnvUpdateResult>;
	/** `PATCH /env` (S8 C2): `null` deletes a key or a file. */
	patchEnv(
		p: Principal,
		idOrSlug: string,
		patch: SecretPatch,
	): Promise<EnvUpdateResult>;
	/** `sandbox_not_ready` (details.state) unless `ready`. */
	resolveAgentTarget(p: Principal, idOrSlug: string): Promise<AgentTarget>;
	createCommand(
		p: Principal,
		idOrSlug: string,
		spec: CommandSpec,
	): Promise<Command>;
	/** `createCommand` under an Idempotency-Key (scope `commands.create`, S7 §9.3). */
	createCommandWithKey(
		p: Principal,
		idOrSlug: string,
		spec: CommandSpec,
		idemKey: string,
		requestBody: unknown,
	): Promise<{ command: Command; replayed: boolean }>;
	/** `starting` → `running` with the agent's pid. */
	markCommandRunning(commandId: string, pid: number | null): Promise<void>;
	/** Newest first; any sandbox state but `deleted`. */
	listCommands(
		p: Principal,
		idOrSlug: string,
		filter: CommandListFilter,
		cursor?: string,
	): Promise<Page<Command>>;
	getCommand(
		p: Principal,
		idOrSlug: string,
		commandId: string,
	): Promise<Command>;
	completeCommand(commandId: string, result: CommandResult): Promise<void>;
	/**
	 * `starting` → `failed_to_start` (the agent refused Start); a command
	 * that moved on (a concurrent replay started it) is left alone.
	 */
	failCommandStart(commandId: string): Promise<void>;
	touchApiActivity(sandboxId: string): Promise<void>;
	/**
	 * Hosts a port or changes its settings with PUT semantics: the call gives
	 * the full desired settings. An omitted `hostRewrite`/`appProtocol` resets
	 * to `preserve`/`http1`, also for the legacy string form (`mode` only).
	 * Same settings: no change (`created: false`, no token). Options only:
	 * no `authEpoch` bump. A mode change bumps it (and issues a token on a
	 * switch to `token`).
	 */
	hostPort(
		p: Principal,
		idOrSlug: string,
		port: number,
		mode: PortMode | HostPortOptions,
	): Promise<HostPortResult>;
	listHostedPorts(p: Principal, idOrSlug: string): Promise<HostedPort[]>;
	unhostPort(p: Principal, idOrSlug: string, port: number): Promise<void>;
	rotatePortToken(
		p: Principal,
		idOrSlug: string,
		port: number,
	): Promise<{ token: string }>;
}

export class SandboxServiceImpl implements SandboxService {
	protected readonly deps: SandboxServiceDeps;

	constructor(deps: SandboxServiceDeps) {
		this.deps = deps;
	}

	create(
		p: Principal,
		input: CreateInput,
		idemKey?: string,
		opts?: CreateOptions,
	): Promise<CreateResult> {
		return createSandbox(this.deps, p, input, idemKey, opts);
	}

	get(p: Principal, idOrSlug: string): Promise<Sandbox> {
		return getSandbox(this.deps, p, idOrSlug);
	}

	list(
		p: Principal,
		filter: ListFilter = {},
		cursor?: string,
	): Promise<Page<Sandbox>> {
		return listSandboxes(this.deps, p, filter, cursor);
	}

	update(p: Principal, idOrSlug: string, patch: UpdateInput): Promise<Sandbox> {
		return updateSandbox(this.deps, p, idOrSlug, patch);
	}

	extend(
		p: Principal,
		idOrSlug: string,
		ttlSeconds?: number,
	): Promise<Sandbox> {
		return extendSandbox(this.deps, p, idOrSlug, ttlSeconds);
	}

	delete(p: Principal, idOrSlug: string): Promise<Operation> {
		return deleteSandbox(this.deps, p, idOrSlug);
	}

	getOperation(p: Principal, id: string): Promise<Operation> {
		return getOperation(this.deps, p, id);
	}

	waitForState(
		id: string,
		states: SandboxState[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Sandbox> {
		return waitForSandboxState(this.deps, id, states, timeoutMs, signal);
	}
	stop(p: Principal, idOrSlug: string): Promise<Operation> {
		return stopSandbox(this.deps, p, idOrSlug);
	}

	resume(
		p: Principal,
		idOrSlug: string,
		input: ResumeInput = {},
	): Promise<Operation> {
		return resumeSandbox(this.deps, p, idOrSlug, input);
	}

	fork(
		p: Principal,
		idOrSlug: string,
		input: ForkInput,
		idemKey?: string,
	): Promise<ForkResult> {
		return forkSandbox(this.deps, p, idOrSlug, input, idemKey);
	}

	recover(p: Principal, idOrSlug: string): Promise<Operation> {
		return recoverSandbox(this.deps, p, idOrSlug);
	}

	saveSnapshot(
		p: Principal,
		idOrSlug: string,
		name: string,
		idemKey?: string,
	): Promise<SaveSnapshotResult> {
		return saveSnapshot(this.deps, p, idOrSlug, name, idemKey);
	}

	deleteSavedSnapshot(
		p: Principal,
		name: string,
		expectedId?: string,
	): Promise<void> {
		return deleteSavedSnapshot(this.deps, p, name, expectedId);
	}

	listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]> {
		return listSavedSnapshots(this.deps, p);
	}

	getSavedSnapshot(p: Principal, name: string): Promise<SavedSnapshot> {
		return getSavedSnapshot(this.deps, p, name);
	}

	waitForOperation(id: string, timeoutMs: number): Promise<Operation> {
		return waitForOperation(this.deps, id, timeoutMs);
	}

	rename(p: Principal, idOrSlug: string, slug: string): Promise<Sandbox> {
		return renameSandbox(this.deps, p, idOrSlug, slug);
	}

	getEnv(p: Principal, idOrSlug: string): Promise<SecretSets> {
		return getEnv(this.deps, p, idOrSlug);
	}

	replaceEnv(
		p: Principal,
		idOrSlug: string,
		input: EnvReplaceInput,
	): Promise<EnvUpdateResult> {
		return replaceEnv(this.deps, p, idOrSlug, input);
	}

	patchEnv(
		p: Principal,
		idOrSlug: string,
		patch: SecretPatch,
	): Promise<EnvUpdateResult> {
		return patchEnv(this.deps, p, idOrSlug, patch);
	}

	resolveAgentTarget(p: Principal, idOrSlug: string): Promise<AgentTarget> {
		return resolveAgentTarget(this.deps, p, idOrSlug);
	}

	createCommand(
		p: Principal,
		idOrSlug: string,
		spec: CommandSpec,
	): Promise<Command> {
		return createCommand(this.deps, p, idOrSlug, spec);
	}

	createCommandWithKey(
		p: Principal,
		idOrSlug: string,
		spec: CommandSpec,
		idemKey: string,
		requestBody: unknown,
	): Promise<{ command: Command; replayed: boolean }> {
		return createCommandWithKey(
			this.deps,
			p,
			idOrSlug,
			spec,
			idemKey,
			requestBody,
		);
	}

	markCommandRunning(commandId: string, pid: number | null): Promise<void> {
		return markCommandRunning(this.deps.pool, commandId, pid);
	}

	listCommands(
		p: Principal,
		idOrSlug: string,
		filter: CommandListFilter = {},
		cursor?: string,
	): Promise<Page<Command>> {
		return listCommands(this.deps, p, idOrSlug, filter, cursor);
	}

	getCommand(
		p: Principal,
		idOrSlug: string,
		commandId: string,
	): Promise<Command> {
		return getCommand(this.deps, p, idOrSlug, commandId);
	}

	completeCommand(commandId: string, result: CommandResult): Promise<void> {
		return completeCommand(this.deps.pool, commandId, result);
	}

	failCommandStart(commandId: string): Promise<void> {
		return failCommandStart(this.deps.pool, commandId);
	}

	touchApiActivity(sandboxId: string): Promise<void> {
		return touchApiActivity(this.deps.pool, sandboxId);
	}

	hostPort(
		p: Principal,
		idOrSlug: string,
		port: number,
		mode: PortMode | HostPortOptions,
	): Promise<HostPortResult> {
		return hostPort(this.deps, p, idOrSlug, port, mode);
	}

	listHostedPorts(p: Principal, idOrSlug: string): Promise<HostedPort[]> {
		return listHostedPorts(this.deps, p, idOrSlug);
	}

	unhostPort(p: Principal, idOrSlug: string, port: number): Promise<void> {
		return unhostPort(this.deps, p, idOrSlug, port);
	}

	rotatePortToken(
		p: Principal,
		idOrSlug: string,
		port: number,
	): Promise<{ token: string }> {
		return rotatePortToken(this.deps, p, idOrSlug, port);
	}
}
