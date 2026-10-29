import type { Principal } from "../principal.ts";
import type { Operation, Page, Sandbox } from "../rows.ts";
import type { SandboxState } from "../states.ts";
import type { SandboxServiceDeps } from "./common.ts";
import {
	type CreateInput,
	type CreateResult,
	createSandbox,
} from "./create.ts";
import { deleteSandbox } from "./delete.ts";
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
export type { ListFilter, UpdateInput } from "./read.ts";

/**
 * Service layer of S7 (S6 §14.1). Ids are UUIDs (S7 encodes public ids); a
 * sandbox may also be addressed by slug. Another team's resources are
 * `not_found`. stop, resume, fork, recover, snapshots, commands and ports are
 * added by later tasks.
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
	getOperation(p: Principal, id: string): Promise<Operation>;
	/** No access check: the caller has read the sandbox with `get` first. */
	waitForState(
		id: string,
		states: SandboxState[],
		timeoutMs: number,
	): Promise<Sandbox>;
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
}
