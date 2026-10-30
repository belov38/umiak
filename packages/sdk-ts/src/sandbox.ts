// A sandbox handle (S7 §8, §15.2): waiting, commands, files, ports, PTY and
// lifecycle. Waits use the api long-polls (`?waitFor=` and operations
// `?waitSeconds=`), never frequent polling.

import type { CallOptions, ClientCore } from "./client.ts";
import {
	Command,
	callOf,
	type Encoding,
	type ExecOptions,
	type ExecResult,
	execCommand,
	type RunEvent,
	type RunOptions,
	runCommand,
	type SandboxRef,
	type StartOptions,
	startCommand,
} from "./commands.ts";
import { SandboxFailedError, SbxError, WAIT_TIMEOUT } from "./errors.ts";
import { Files } from "./files.ts";
import type { components } from "./gen/v1.d.ts";
import { newIdempotencyKey } from "./ids.ts";
import {
	connectPty,
	openPty,
	type Pty,
	type PtyConnectOptions,
	type PtyOptions,
} from "./pty.ts";

export type SandboxData = components["schemas"]["Sandbox"];
/** An Operation (`op_...`); the document marks the schema nullable. */
export type OperationData = components["schemas"]["Operation"];
type Operation = NonNullable<OperationData>;
export type HostedPort = components["schemas"]["HostedPort"];
export type HostedPortWrite = components["schemas"]["HostedPortWrite"];
export type SandboxPorts = components["schemas"]["SandboxPorts"];
export type PortToken = components["schemas"]["PortToken"];
export type ForkInput = components["schemas"]["ForkSandboxRequest"];
export type ResumeInput = components["schemas"]["ResumeSandboxRequest"];

export interface WaitOptions {
	/** Overall limit; default 300 000 ms for ready, none for operations. */
	timeoutMs?: number;
	signal?: AbortSignal;
	retryBudgetMs?: number;
}

/** CallOptions plus waiting for the result of the action. */
export interface ActionOptions extends CallOptions {
	wait?: boolean;
	waitTimeoutMs?: number;
}

export interface HostOptions extends CallOptions {
	access?: "token" | "sso" | "public";
	hostRewrite?: "preserve" | "localhost";
	appProtocol?: "http1" | "h2c";
}

/** The default limit of waitUntilReady (S7 §15.4). */
export const READY_TIMEOUT_MS = 300_000;
/** Seconds of one long-poll (the api allows up to 60). */
const POLL_SECONDS = 30;
/** Sandbox states that end a wait for `ready` with SandboxFailedError. */
const FAILED_STATES = new Set(["error", "deleting", "deleted", "stopped"]);
const FINAL_OPERATION_STATES = new Set(["succeeded", "failed", "superseded"]);
const SANDBOX = "/v1/sandboxes/{sandbox}";

export class Sandbox implements SandboxRef {
	readonly core: ClientCore;
	data: SandboxData;
	readonly files: Files;
	readonly ports: {
		/** Publishes a port (PUT: omitted settings take their defaults). */
		host(port: number, opts?: HostOptions): Promise<HostedPortWrite>;
		list(opts?: CallOptions): Promise<SandboxPorts>;
		unhost(port: number, opts?: CallOptions): Promise<void>;
		/** A new token; the old one and its cookies stop working at once. */
		rotateToken(port: number, opts?: CallOptions): Promise<PortToken>;
	};

	constructor(core: ClientCore, data: SandboxData) {
		this.core = core;
		this.data = data;
		this.files = new Files(this);
		this.ports = {
			host: async (port, opts = {}) => {
				const body: components["schemas"]["HostPortRequest"] = {};
				if (opts.access !== undefined) body.access = opts.access;
				if (opts.hostRewrite !== undefined) body.hostRewrite = opts.hostRewrite;
				if (opts.appProtocol !== undefined) body.appProtocol = opts.appProtocol;
				const { data } = await this.core.raw.PUT(`${SANDBOX}/ports/{port}`, {
					params: { path: { sandbox: this.id, port } },
					body,
					...callOf(opts),
				});
				return data;
			},
			list: async (opts = {}) => {
				const { data } = await this.core.raw.GET(`${SANDBOX}/ports`, {
					params: { path: { sandbox: this.id } },
					...callOf(opts),
				});
				return data;
			},
			unhost: async (port, opts = {}) => {
				await this.core.raw.DELETE(`${SANDBOX}/ports/{port}`, {
					params: { path: { sandbox: this.id, port } },
					...callOf(opts),
				});
			},
			rotateToken: async (port, opts = {}) => {
				const { data } = await this.core.raw.POST(
					`${SANDBOX}/ports/{port}/rotate-token`,
					{ params: { path: { sandbox: this.id, port } }, ...callOf(opts) },
				);
				return data;
			},
		};
	}

	/** `sb_...` */
	get id(): string {
		return this.data.id;
	}

	get slug(): string {
		return this.data.slug;
	}

	get state(): SandboxData["state"] {
		return this.data.state;
	}

	#path() {
		return { path: { sandbox: this.id } };
	}

	async refresh(opts: CallOptions = {}): Promise<SandboxData> {
		const { data } = await this.core.raw.GET(SANDBOX, {
			params: this.#path(),
			...callOf(opts),
		});
		this.data = data;
		return data;
	}

	/**
	 * Waits for `ready` by long-poll. SandboxFailedError when the sandbox
	 * becomes error, deleting, deleted or stopped; `wait_timeout` after
	 * `timeoutMs` (default 300 s); `signal` aborts at once.
	 */
	async waitUntilReady(opts: WaitOptions = {}): Promise<this> {
		const { signal } = opts;
		const deadline = Date.now() + (opts.timeoutMs ?? READY_TIMEOUT_MS);
		for (;;) {
			signal?.throwIfAborted();
			const left = deadline - Date.now();
			if (left <= 0) {
				throw waitTimeout(`sandbox ${this.slug} is still ${this.data.state}`);
			}
			// Answers at once when the state is already ready, stopped or final.
			const { data } = await this.core.raw.GET(SANDBOX, {
				params: {
					...this.#path(),
					query: {
						waitFor: "ready,stopped",
						waitSeconds: Math.max(
							1,
							Math.min(POLL_SECONDS, Math.ceil(left / 1000)),
						),
					},
				},
				...callOf(opts),
			});
			this.data = data;
			const state = data.state;
			if (state === "ready") return this;
			if (FAILED_STATES.has(state)) {
				throw new SandboxFailedError({
					status: 409,
					code: "sandbox_failed",
					message: `sandbox ${this.slug} is ${state}, not ready`,
					retryable: false,
					details: { state, sandboxId: this.id },
				});
			}
		}
	}

	/** Waits by long-poll until the operation is final (succeeded, failed, superseded). */
	async waitForOperation(
		op: string | { id: string },
		opts: WaitOptions = {},
	): Promise<Operation> {
		return waitForOperation(this.core, op, opts);
	}

	/**
	 * Runs a command and returns its output in the shape of a sync result
	 * (the last 4 MiB per stream). Sent as `mode: stream` with an
	 * Idempotency-Key, so a retry never starts it twice and no proxy cuts a
	 * silent request; breaks are resumed like `run`.
	 */
	exec(cmd: string | string[], opts: ExecOptions = {}): Promise<ExecResult> {
		return execCommand(this, cmd, opts);
	}

	/** Runs a command and yields its output; breaks are resumed by offset. */
	run<E extends Encoding = "utf8">(
		cmd: string | string[],
		opts: RunOptions<E> = {},
	): AsyncIterable<RunEvent<E>> {
		return runCommand(this, cmd, opts);
	}

	/** Starts a detached command; follow it with `Command.follow`. */
	start(cmd: string | string[], opts: StartOptions = {}): Promise<Command> {
		return startCommand(this, cmd, opts);
	}

	/** A handle of an existing command (`cmd_...`); nothing is fetched. */
	command(id: string): Command {
		return new Command(this, id);
	}

	/** Creates a terminal and connects to it over WebSocket (Node, Bun). */
	pty(opts: PtyOptions = {}): Promise<Pty> {
		return openPty(this, opts);
	}

	/** Connects to an existing terminal command. */
	connectPty(id: string, opts: PtyConnectOptions = {}): Promise<Pty> {
		return connectPty(this, new Command(this, id), opts);
	}

	/**
	 * Stops the sandbox. Returns the stop operation (null if there is none);
	 * `wait`: until it is final.
	 */
	async stop(opts: ActionOptions = {}): Promise<OperationData> {
		const { data } = await this.core.raw.POST(`${SANDBOX}/stop`, {
			params: this.#path(),
			...callOf(opts),
		});
		return this.#after(data, opts);
	}

	/** Resumes a stopped sandbox; `wait`: until it is ready. */
	async resume(
		input: ResumeInput = {},
		opts: ActionOptions = {},
	): Promise<OperationData> {
		const { data } = await this.core.raw.POST(`${SANDBOX}/resume`, {
			params: this.#path(),
			body: input,
			...callOf(opts),
		});
		const op = await this.#after(data, { ...opts, wait: false });
		if (opts.wait) await this.#waitReady(opts);
		return op;
	}

	/** A copy of this sandbox; `wait`: until the copy is ready. */
	async fork(
		input: ForkInput = {},
		opts: ActionOptions = {},
	): Promise<Sandbox> {
		const { data } = await this.core.raw.POST(`${SANDBOX}/fork`, {
			params: this.#path(),
			body: input,
			...callOf(opts),
			idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey(),
		});
		const copy = new Sandbox(this.core, data.sandbox);
		if (opts.wait) await copy.#waitReady(opts);
		return copy;
	}

	/**
	 * Deletes the sandbox (a running one too: no stop needed). Sets
	 * `Sbx-Confirm-Delete` to this sandbox's id. Returns the delete operation,
	 * or null when it was already deleted; `wait`: until it is final.
	 */
	async delete(opts: ActionOptions = {}): Promise<OperationData> {
		const { data } = await this.core.raw.DELETE(SANDBOX, {
			params: this.#path(),
			headers: { "Sbx-Confirm-Delete": this.id },
			...callOf(opts),
		});
		this.data = data.sandbox;
		const op = data.operation;
		if (op === null || !opts.wait) return op;
		const done = await this.waitForOperation(op, waitOpts(opts));
		await this.refresh(callOf(opts));
		return done;
	}

	/** The same as `delete` (S7 §15.4: a delete needs no stop first). */
	stopAndDelete(opts: ActionOptions = {}): Promise<OperationData> {
		return this.delete(opts);
	}

	async #after(
		data: { sandbox: SandboxData; operation: OperationData },
		opts: ActionOptions,
	): Promise<OperationData> {
		this.data = data.sandbox;
		const op = data.operation;
		if (op === null || !opts.wait) return op;
		const done = await this.waitForOperation(op, waitOpts(opts));
		await this.refresh(callOf(opts));
		return done;
	}

	async #waitReady(opts: ActionOptions) {
		await this.waitUntilReady({
			...waitOpts(opts),
			...(opts.waitTimeoutMs === undefined
				? {}
				: { timeoutMs: opts.waitTimeoutMs }),
		});
	}
}

function waitOpts(opts: ActionOptions): WaitOptions {
	const w: WaitOptions = {};
	if (opts.signal !== undefined) w.signal = opts.signal;
	if (opts.retryBudgetMs !== undefined) w.retryBudgetMs = opts.retryBudgetMs;
	if (opts.waitTimeoutMs !== undefined) w.timeoutMs = opts.waitTimeoutMs;
	return w;
}

function waitTimeout(message: string): SbxError {
	return new SbxError({
		status: 0,
		code: WAIT_TIMEOUT,
		message,
		retryable: true,
	});
}

/** Long-polls an operation until it is final; `timeoutMs` default: none. */
export async function waitForOperation(
	core: ClientCore,
	op: string | { id: string },
	opts: WaitOptions = {},
): Promise<Operation> {
	const id = typeof op === "string" ? op : op.id;
	const { signal } = opts;
	const deadline =
		opts.timeoutMs === undefined
			? Number.POSITIVE_INFINITY
			: Date.now() + opts.timeoutMs;
	for (;;) {
		signal?.throwIfAborted();
		const left = deadline - Date.now();
		if (left <= 0) throw waitTimeout(`operation ${id} is not final yet`);
		const { data } = await core.raw.GET("/v1/operations/{operation}", {
			params: {
				path: { operation: id },
				query: {
					waitSeconds: Math.max(
						1,
						Math.min(POLL_SECONDS, Math.ceil(left / 1000)),
					),
				},
			},
			...callOf(opts),
		});
		if (data === null) {
			throw new SbxError({
				status: 200,
				code: "unexpected_response",
				message: `GET /v1/operations/${id} answered null`,
				retryable: false,
			});
		}
		if (FINAL_OPERATION_STATES.has(data.state)) return data;
	}
}
