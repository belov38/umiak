// The SDK facade (S7 §15.2): `new Sbx(opts)`.
//
//   const sbx = new Sbx({ baseUrl, apiKey })        // or the credential chain
//   const sb = await sbx.sandboxes.create({ template: "linux" }, { wait: true })
//   const r = await sb.exec("npm test")
//   for await (const s of sbx.sandboxes.list({ label: { session: "42" } })) { ... }
//
// Every method takes CallOptions {signal, retryBudgetMs, idempotencyKey};
// `sbx.raw` is the typed openapi-fetch client with the same transport.

import {
	type CallOptions,
	type ClientCore,
	createClientCore,
	type RawClient,
	type SbxOptions,
} from "./client.ts";
import { callOf } from "./commands.ts";
import { SbxError } from "./errors.ts";
import type { components } from "./gen/v1.d.ts";
import { newIdempotencyKey } from "./ids.ts";
import { paginate } from "./pages.ts";
import {
	type ActionOptions,
	type OperationData,
	Sandbox,
	type SandboxData,
	type WaitOptions,
	waitForOperation,
} from "./sandbox.ts";

export type CreateSandboxInput = components["schemas"]["CreateSandboxRequest"];
export type SnapshotData = components["schemas"]["Snapshot"];
export type CreateSnapshotInput =
	components["schemas"]["CreateSnapshotRequest"];

export interface SandboxFilter {
	/** One state or several (any of them). */
	state?: SandboxData["state"] | SandboxData["state"][];
	/** Every label must match. */
	label?: Record<string, string>;
	template?: string;
	/** Search in slug and name. */
	q?: string;
	/** Page size (the iterator still returns everything). */
	limit?: number;
}

export interface CreateOptions extends CallOptions {
	/** Wait until the sandbox is ready (SandboxFailedError if it fails). */
	wait?: boolean;
	/** Limit of that wait; default 300 000 ms. */
	waitTimeoutMs?: number;
}

export class Sbx {
	/** The typed raw client (openapi-fetch) with retries and credentials. */
	readonly raw: RawClient;
	readonly sandboxes: {
		create(input?: CreateSandboxInput, opts?: CreateOptions): Promise<Sandbox>;
		/** By id (`sb_...`) or slug. */
		get(ref: string, opts?: CallOptions): Promise<Sandbox>;
		/**
		 * A handle by id or slug without a request: for commands, files and
		 * ports (their paths take either). `data` holds only `id` and `slug`
		 * (both `ref`) until `refresh`.
		 */
		handle(ref: string): Sandbox;
		/** Every sandbox of the team matching the filter, newest first, all pages. */
		list(
			filter?: SandboxFilter,
			opts?: CallOptions,
		): AsyncIterable<SandboxData>;
	};
	readonly snapshots: {
		/** `wait`: until the snapshot operation is final (the snapshot is then re-read). */
		create(
			input: CreateSnapshotInput,
			opts?: ActionOptions,
		): Promise<SnapshotData>;
		get(name: string, opts?: CallOptions): Promise<SnapshotData>;
		list(opts?: CallOptions): AsyncIterable<SnapshotData>;
		/** Sets `Sbx-Confirm-Delete` to the snapshot's id (read first). */
		delete(name: string, opts?: CallOptions): Promise<void>;
	};
	readonly #core: ClientCore;

	constructor(opts: SbxOptions = {}) {
		const core = createClientCore(opts);
		this.#core = core;
		this.raw = core.raw;
		this.sandboxes = {
			create: async (input = {}, o = {}) => {
				const { data } = await core.raw.POST("/v1/sandboxes", {
					body: input,
					...callOf(o),
					idempotencyKey: o.idempotencyKey ?? newIdempotencyKey(),
				});
				const sb = new Sandbox(core, data.sandbox);
				if (o.wait) {
					await sb.waitUntilReady({
						...waitOf(o),
						...(o.waitTimeoutMs === undefined
							? {}
							: { timeoutMs: o.waitTimeoutMs }),
					});
				}
				return sb;
			},
			get: async (ref, o = {}) => {
				const { data } = await core.raw.GET("/v1/sandboxes/{sandbox}", {
					params: { path: { sandbox: ref } },
					...callOf(o),
				});
				return new Sandbox(core, data);
			},
			handle: (ref) => new Sandbox(core, { id: ref, slug: ref } as SandboxData),
			list: (filter = {}, o = {}) =>
				paginate(async (cursor) => {
					const query: Record<string, unknown> = {};
					if (filter.state !== undefined) {
						query.state = Array.isArray(filter.state)
							? filter.state.join(",")
							: filter.state;
					}
					if (filter.label !== undefined) {
						query.label = Object.entries(filter.label).map(
							([k, v]) => `${k}=${v}`,
						);
					}
					if (filter.template !== undefined) query.template = filter.template;
					if (filter.q !== undefined) query.q = filter.q;
					if (filter.limit !== undefined) query.limit = filter.limit;
					if (cursor !== undefined) query.cursor = cursor;
					const { data } = await core.raw.GET("/v1/sandboxes", {
						params: { query },
						...callOf(o),
					});
					return data;
				}),
		};
		this.snapshots = {
			create: async (input, o = {}) => {
				const { data } = await core.raw.POST("/v1/snapshots", {
					body: input,
					...callOf(o),
					idempotencyKey: o.idempotencyKey ?? newIdempotencyKey(),
				});
				if (!o.wait) return data.snapshot;
				const op = await waitForOperation(core, data.operation, waitOf(o));
				if (op.state !== "succeeded") throw operationFailed(op);
				return this.snapshots.get(input.name, callOf(o));
			},
			get: async (name, o = {}) => {
				const { data } = await core.raw.GET("/v1/snapshots/{name}", {
					params: { path: { name } },
					...callOf(o),
				});
				return data;
			},
			list: (o = {}) =>
				paginate(async () => {
					const { data } = await core.raw.GET("/v1/snapshots", callOf(o));
					return { data: data.data, nextCursor: null };
				}),
			delete: async (name, o = {}) => {
				const snap = await this.snapshots.get(name, callOf(o));
				await core.raw.DELETE("/v1/snapshots/{name}", {
					params: { path: { name } },
					headers: { "Sbx-Confirm-Delete": snap.id },
					...callOf(o),
				});
			},
		};
	}

	/** Long-polls an operation (`op_...`) until it is final. */
	waitForOperation(
		op: string | { id: string },
		opts: WaitOptions = {},
	): Promise<OperationData> {
		return waitForOperation(this.#core, op, opts);
	}

	async me(opts: CallOptions = {}): Promise<components["schemas"]["Me"]> {
		const { data } = await this.raw.GET("/v1/me", callOf(opts));
		return data;
	}

	async limits(
		opts: CallOptions = {},
	): Promise<components["schemas"]["Limits"]> {
		const { data } = await this.raw.GET("/v1/limits", callOf(opts));
		return data;
	}

	async templates(
		opts: CallOptions = {},
	): Promise<components["schemas"]["Template"][]> {
		const { data } = await this.raw.GET("/v1/templates", callOf(opts));
		return data.data;
	}

	async sizes(
		opts: CallOptions = {},
	): Promise<components["schemas"]["Size"][]> {
		const { data } = await this.raw.GET("/v1/sizes", callOf(opts));
		return data.data;
	}
}

/** The error of an operation that did not succeed (failed or superseded). */
function operationFailed(op: OperationData): SbxError {
	const e = op.error;
	return new SbxError({
		status: 0,
		code: e?.code ?? `operation_${op.state}`,
		message: e?.message ?? `operation ${op.id} (${op.kind}) is ${op.state}`,
		retryable: e?.retryable ?? false,
		details: { operationId: op.id, kind: op.kind, state: op.state },
	});
}

function waitOf(o: CallOptions): WaitOptions {
	const w: WaitOptions = {};
	if (o.signal !== undefined) w.signal = o.signal;
	if (o.retryBudgetMs !== undefined) w.retryBudgetMs = o.retryBudgetMs;
	return w;
}
