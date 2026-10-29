import type {
	DescMessage,
	DescMethodStreaming,
	DescMethodUnary,
	MessageInitShape,
} from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	type ContextValues,
	type StreamResponse,
	type Transport,
	type UnaryResponse,
} from "@connectrpc/connect";
import { createAsyncIterable } from "@connectrpc/connect/protocol";
import {
	createConnectTransport,
	Http2SessionManager,
} from "@connectrpc/connect-node";
import {
	AgentOutdatedError,
	classify,
	classifyByCode,
	movedInstanceUrl,
} from "./errors.js";
import { type AgentFetchInit, routedFetch } from "./fetch.js";
import type { Registry } from "./registry.js";
import {
	type AttemptOutcome,
	routeCall,
	type Target,
	waitForRoute,
} from "./routing.js";

export interface AgentClientOptions {
	/** Where machines are served (PgRegistry in production). */
	registry: Registry;
	/** Service token sent as Authorization: Bearer to the gateway internal listener. */
	serviceToken: string;
	/** How long to wait for a machine without a usable route. Default 30000. */
	waitForAgentMs?: number;
	/** Upper bound of one registry wait (poll in case a NOTIFY is missed). Default 1000. */
	pollIntervalMs?: number;
	/**
	 * Maximum immediate attempts against gateway instances per call (421
	 * redirects, connection errors). Attempts after a registry wait are
	 * bounded by waitForAgentMs instead. Default 10.
	 */
	maxAttempts?: number;
	/** Timeout of establishing an HTTP/2 connection to a gateway instance (default transport). Default 5000. */
	connectTimeoutMs?: number;
	/**
	 * Creates the Connect transport for one base URL
	 * (<internal_url>/v1/machines/<id>/rpc) with the given request headers.
	 * Default: connect-node Connect protocol over HTTP/2 (h2c), one HTTP/2
	 * session per gateway instance.
	 */
	createTransport?: (
		baseUrl: string,
		headers: Record<string, string>,
	) => Transport;
}

/** Underlying transports kept per base URL (machine x instance). */
const maxCachedTransports = 4096;

/**
 * Calls the guest agent through the gateway internal listener: a Connect
 * transport per machine and a plain HTTP fetch for the agent's /files/*. Both
 * find the owning gateway instance in the registry and follow 421/503 answers
 * (spec section 8.4).
 */
export class AgentClient {
	private readonly registry: Registry;
	private readonly serviceToken: string;
	private readonly waitForAgentMs: number;
	private readonly pollIntervalMs: number;
	private readonly maxAttempts: number;
	private readonly connectTimeoutMs: number;
	private readonly createTransport: (
		baseUrl: string,
		headers: Record<string, string>,
	) => Transport;
	private readonly transports = new Map<string, Transport>();
	private readonly sessions = new Map<string, Http2SessionManager>();

	constructor(opts: AgentClientOptions) {
		this.registry = opts.registry;
		this.serviceToken = opts.serviceToken;
		this.waitForAgentMs = opts.waitForAgentMs ?? 30_000;
		this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
		this.maxAttempts = opts.maxAttempts ?? 10;
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
		this.createTransport =
			opts.createTransport ??
			((baseUrl, headers) => this.defaultTransport(baseUrl, headers));
	}

	/**
	 * A Connect transport for one machine with routing and retries: unary calls
	 * and server streams (until the response headers arrive) are retried on 421,
	 * 503 agent_unavailable, Code.Unavailable and connection errors. Caller
	 * headers (Sbx-Request-Id) are resent unchanged. Caller abort and the Connect
	 * deadline are never retried. Messages of a stream that already started are
	 * not retried; use resumableAttach for that.
	 */
	transport(machineId: string): Transport {
		return {
			unary: (method, signal, timeoutMs, header, input, contextValues) =>
				this.unary(
					machineId,
					method,
					signal,
					timeoutMs,
					header,
					input,
					contextValues,
				),
			stream: (method, signal, timeoutMs, header, input, contextValues) =>
				this.stream(
					machineId,
					method,
					signal,
					timeoutMs,
					header,
					input,
					contextValues,
				),
		};
	}

	/**
	 * Resolves when the machine's agent reports the capability; throws
	 * AgentOutdatedError when its known capabilities lack it, and
	 * AgentUnavailableError when the machine is not connected, or its
	 * capabilities stay unknown (null, before Control/Info), within
	 * waitForAgentMs.
	 */
	async requireCapability(
		machineId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<void> {
		const route = await waitForRoute(
			{
				...this.routingBase(machineId),
				signal,
				abortError: (reason) => reason,
			},
			(r) => r.capabilities !== null,
		);
		if (!route.capabilities?.includes(capability)) {
			throw new AgentOutdatedError(machineId, capability);
		}
	}

	/**
	 * Routed plain HTTP to the agent's /files/* (Range downloads, chunked
	 * resumable uploads). path is "" or starts with "/" or "?" (query kept);
	 * the request goes to <internal_url>/v1/machines/<id>/files<path> over
	 * HTTP/1.1 with Authorization: Bearer <serviceToken>.
	 *
	 * 421, 503 with Sbx-Error-Code: agent_unavailable and network errors before a
	 * response are retried when the body is absent, resendable or a factory. A
	 * ReadableStream body is sent once: after a 421/503 that Response is
	 * returned. Every other status is returned as is with a streamed body;
	 * redirects are never followed (init.redirect is ignored), a 3xx is
	 * returned as the Response.
	 */
	fetch(
		machineId: string,
		path: string,
		init: AgentFetchInit = {},
	): Promise<Response> {
		return routedFetch(this.routingBase(machineId), path, init);
	}

	/** Closes the HTTP/2 sessions of the default transports. The registry is not closed. */
	async close(): Promise<void> {
		for (const s of this.sessions.values()) {
			s.abort();
		}
		this.sessions.clear();
		this.transports.clear();
	}

	private routingBase(machineId: string) {
		return {
			registry: this.registry,
			serviceToken: this.serviceToken,
			machineId,
			waitForAgentMs: this.waitForAgentMs,
			pollIntervalMs: this.pollIntervalMs,
			maxAttempts: this.maxAttempts,
		};
	}

	/** The transport for a routing target; it carries the target's Authorization. */
	private underlying(machineId: string, target: Target): Transport {
		const baseUrl = `${target.instanceUrl.replace(/\/+$/, "")}/v1/machines/${machineId}/rpc`;
		let t = this.transports.get(baseUrl);
		if (t === undefined) {
			t = this.createTransport(baseUrl, {
				Authorization: target.authorization,
			});
			if (this.transports.size >= maxCachedTransports) {
				const oldest = this.transports.keys().next().value;
				if (oldest !== undefined) {
					this.transports.delete(oldest);
				}
			}
			this.transports.set(baseUrl, t);
		}
		return t;
	}

	private defaultTransport(
		baseUrl: string,
		headers: Record<string, string>,
	): Transport {
		const origin = new URL(baseUrl).origin;
		let session = this.sessions.get(origin);
		if (session === undefined) {
			session = new Http2SessionManager(origin, {
				pingIntervalMs: 10_000,
				pingTimeoutMs: 5000,
				connectTimeoutMs: this.connectTimeoutMs,
			});
			this.sessions.set(origin, session);
		}
		return createConnectTransport({
			baseUrl,
			httpVersion: "2",
			sessionManager: session,
			interceptors: [
				(next) => (req) => {
					for (const [k, v] of Object.entries(headers)) {
						req.header.set(k, v);
					}
					return next(req);
				},
			],
		});
	}

	private callRouting(
		machineId: string,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	) {
		const deadline =
			timeoutMs !== undefined && timeoutMs > 0
				? Date.now() + timeoutMs
				: undefined;
		return {
			...this.routingBase(machineId),
			signal,
			abortError: (reason: unknown) => ConnectError.from(reason, Code.Canceled),
			deadline,
			deadlineError: () =>
				new ConnectError("the operation timed out", Code.DeadlineExceeded),
		};
	}

	/** Maps an attempt error to a routing outcome; fatal errors are rethrown. */
	private outcome<T>(
		err: unknown,
		signal: AbortSignal | undefined,
	): AttemptOutcome<T> {
		const c = classify(err, signal);
		if (c === "fatal") {
			throw err;
		}
		if (c === "moved") {
			return {
				kind: "moved",
				instanceUrl: movedInstanceUrl(err),
				cause: err,
				// Not a gateway's 421: the Connect code alone decides.
				notMoved: () => {
					if (classifyByCode(err, signal) === "fatal") {
						throw err;
					}
					return { kind: "unavailable", cause: err };
				},
			};
		}
		return { kind: "unavailable", cause: err };
	}

	private unary<I extends DescMessage, O extends DescMessage>(
		machineId: string,
		method: DescMethodUnary<I, O>,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
		header: HeadersInit | undefined,
		input: MessageInitShape<I>,
		contextValues: ContextValues | undefined,
	): Promise<UnaryResponse<I, O>> {
		const headers = snapshot(header);
		const routing = this.callRouting(machineId, signal, timeoutMs);
		return routeCall(routing, async (target) => {
			try {
				const res = await this.underlying(machineId, target).unary(
					method,
					signal,
					remaining(routing.deadline, timeoutMs),
					new Headers(headers),
					input,
					contextValues,
				);
				return { kind: "done", value: res };
			} catch (err) {
				return this.outcome(err, signal);
			}
		});
	}

	private async stream<I extends DescMessage, O extends DescMessage>(
		machineId: string,
		method: DescMethodStreaming<I, O>,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
		header: HeadersInit | undefined,
		input: AsyncIterable<MessageInitShape<I>>,
		contextValues: ContextValues | undefined,
	): Promise<StreamResponse<I, O>> {
		const headers = snapshot(header);
		const routing = this.callRouting(machineId, signal, timeoutMs);
		// Buffer the input so it can be resent. Only server streams are used
		// (no bidi, spec section 9.3), so the input is one message.
		const messages: MessageInitShape<I>[] = [];
		for await (const m of input) {
			messages.push(m);
		}
		return routeCall(routing, async (target) => {
			try {
				const res = await this.underlying(machineId, target).stream(
					method,
					signal,
					remaining(routing.deadline, timeoutMs),
					new Headers(headers),
					createAsyncIterable(messages),
					contextValues,
				);
				const value: StreamResponse<I, O> = {
					...res,
					message: this.watch(machineId, res.message, signal),
				};
				return { kind: "done", value };
			} catch (err) {
				return this.outcome(err, signal);
			}
		});
	}

	/** Invalidates the cached route when a started stream fails retryably. */
	private async *watch<T>(
		machineId: string,
		messages: AsyncIterable<T>,
		signal: AbortSignal | undefined,
	): AsyncGenerator<T> {
		try {
			yield* messages;
		} catch (err) {
			if (classify(err, signal) !== "fatal") {
				this.registry.invalidate(machineId);
			}
			throw err;
		}
	}
}

function snapshot(header: HeadersInit | undefined): [string, string][] {
	return [...new Headers(header).entries()];
}

/** Time left for the next attempt, or the caller's value without a deadline. */
function remaining(
	deadline: number | undefined,
	timeoutMs: number | undefined,
): number | undefined {
	if (deadline === undefined) {
		return timeoutMs;
	}
	return Math.max(1, deadline - Date.now());
}
