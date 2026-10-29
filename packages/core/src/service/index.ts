import type { Principal } from "../principal.ts";
import type {
	Command,
	Operation,
	Page,
	PortMode,
	Sandbox,
	SavedSnapshot,
} from "../rows.ts";
import type { SandboxState } from "../states.ts";
import {
	type AgentTarget,
	type CommandResult,
	type CommandSpec,
	completeCommand,
	createCommand,
	resolveAgentTarget,
	touchApiActivity,
} from "./commands.ts";
import type { SandboxServiceDeps } from "./common.ts";
import {
	type CreateInput,
	type CreateResult,
	createSandbox,
} from "./create.ts";
import { deleteSandbox } from "./delete.ts";
import { type ForkInput, type ForkResult, forkSandbox } from "./fork.ts";
import {
	type ResumeInput,
	recoverSandbox,
	resumeSandbox,
	stopSandbox,
} from "./lifecycle.ts";
import {
	type HostPortResult,
	hostPort,
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
	waitForSandboxState,
} from "./read.ts";
import {
	deleteSavedSnapshot,
	listSavedSnapshots,
	type SaveSnapshotResult,
	saveSnapshot,
} from "./snapshots.ts";

export {
	type AgentTarget,
	API_ACTIVITY_THROTTLE_SECONDS,
	COMMAND_CMD_MAX_BYTES,
	COMMAND_MODES,
	type CommandResult,
	type CommandSpec,
	completeCommand,
	TERMINAL_COMMAND_STATUSES,
	truncateUtf8,
} from "./commands.ts";
export type { SandboxServiceDeps } from "./common.ts";
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
	type CreateResult,
	OUT_OF_CAPACITY_RETRY_SECONDS,
	POOL_EXHAUSTED_RETRY_SECONDS,
} from "./create.ts";
export {
	admitCold,
	claimWarm,
	type Placement,
} from "./create-placement.ts";
export { requestSystemDelete } from "./delete.ts";
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
	type HostPortResult,
	MAX_HOSTED_PORTS,
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
	create(
		p: Principal,
		input: CreateInput,
		idemKey?: string,
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
	deleteSavedSnapshot(p: Principal, name: string): Promise<void>;
	listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]>;
	getOperation(p: Principal, id: string): Promise<Operation>;
	/** No access check: the caller has read the sandbox with `get` first. */
	waitForState(
		id: string,
		states: SandboxState[],
		timeoutMs: number,
	): Promise<Sandbox>;
	/** `sandbox_not_ready` (details.state) unless `ready`. */
	resolveAgentTarget(p: Principal, idOrSlug: string): Promise<AgentTarget>;
	createCommand(
		p: Principal,
		idOrSlug: string,
		spec: CommandSpec,
	): Promise<Command>;
	completeCommand(commandId: string, result: CommandResult): Promise<void>;
	touchApiActivity(sandboxId: string): Promise<void>;
	hostPort(
		p: Principal,
		idOrSlug: string,
		port: number,
		mode: PortMode,
	): Promise<HostPortResult>;
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
	): Promise<CreateResult> {
		return createSandbox(this.deps, p, input, idemKey);
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
	): Promise<Sandbox> {
		return waitForSandboxState(this.deps, id, states, timeoutMs);
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

	deleteSavedSnapshot(p: Principal, name: string): Promise<void> {
		return deleteSavedSnapshot(this.deps, p, name);
	}

	listSavedSnapshots(p: Principal): Promise<SavedSnapshot[]> {
		return listSavedSnapshots(this.deps, p);
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

	completeCommand(commandId: string, result: CommandResult): Promise<void> {
		return completeCommand(this.deps.pool, commandId, result);
	}

	touchApiActivity(sandboxId: string): Promise<void> {
		return touchApiActivity(this.deps.pool, sandboxId);
	}

	hostPort(
		p: Principal,
		idOrSlug: string,
		port: number,
		mode: PortMode,
	): Promise<HostPortResult> {
		return hostPort(this.deps, p, idOrSlug, port, mode);
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
