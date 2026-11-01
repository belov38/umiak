// Types and in-memory state of the fake API, plus the context object
// (`Fake`) that the route modules share.
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Contract } from "./openapi-check.ts";
import { SandboxFs } from "./vfs.ts";

export const FAKE_TEAM = "team_fake";
export const OTHER_TEAM = "team_other";
export const SBX_DOMAIN = "sbx.example.com";

export const FULL_SCOPES = [
	"sandboxes:read",
	"sandboxes:write",
	"sandboxes:delete",
	"commands:read",
	"commands:exec",
	"files:read",
	"files:write",
	"ports:write",
	"ssh:connect",
	"snapshots:read",
	"snapshots:write",
	"environments:read",
	"environments:write",
	"keys:admin",
	// S10 (not in v1.json yet; openapi-check.ts adds it to the Me scopes).
	"desktop",
];

export const READ_ONLY_SCOPES = [
	"sandboxes:read",
	"commands:read",
	"files:read",
	"snapshots:read",
	"environments:read",
];

export interface FakePrincipal {
	kind: "oidc" | "team_key";
	scopes: string[];
	/**
	 * The default team; in a request, the team it acts in (the fake replaces
	 * it with the team Sbx-Team selected).
	 */
	teamId: string;
	/** oidc: the person's other teams, selectable with Sbx-Team. */
	teams?: string[];
	/** oidc: the person; team_key: the creator shown in /v1/me. */
	userEmail?: string;
	keyId?: string;
	expiresAt?: string;
	disabled?: boolean;
}

export interface FakeScript {
	/**
	 * A POST /commands that starts a command answers after this delay (the
	 * command is started at once); a replay by Idempotency-Key answers at once.
	 */
	holdCommandsPostMs?: number;
	/** Cut the next NDJSON stream once it has carried this many output bytes. */
	breakStreamAfterBytes?: number;
	/** Long-polls never answer. */
	silent?: boolean;
	/** The next request with this bearer is 401 token_expired. */
	expireTokenOnce?: string;
	/** The next request whose "METHOD /path" matches fails like this (once). */
	failNext?: {
		path: RegExp;
		status: number;
		code: string;
		retryable: boolean;
		/** Default: `injected failure <code>`. */
		message?: string;
	};
	/** Every request whose "METHOD /path" matches answers this much later. */
	slow?: { path: RegExp; ms: number };
	/**
	 * Called by GET /files/content after the file is read and before the
	 * answer is sent: a test changes the file in between (a race with a reader
	 * that read, then writes). Not cleared by the fake; the callback removes
	 * itself when it should fire once.
	 */
	onFileRead?: (e: { sandboxId: string; path: string }) => void | Promise<void>;
	/** Desktop routes answer like an API without S10: the plain 404. */
	noDesktopRoutes?: boolean;
	/** The next create ends in `error` with this error. */
	createFails?: { code: string; message: string };
	/**
	 * Test-only: the next request whose "METHOD /path" matches is answered with
	 * this JSON body (status default 200) instead of the handler's, to prove the
	 * contract check catches a drifting fake.
	 */
	badResponse?: { path: RegExp; status?: number; body: unknown };
}

export interface FakeApiOptions {
	/** creating/starting -> ready after this long (default 50). */
	readyAfterMs?: number;
	/** Silence before a `heartbeat` frame (default 500; the real API: 15 s). */
	heartbeatMs?: number;
	/** Keep only the last N bytes of every command stream (default: all). */
	retentionBytes?: number;
	/** Default screen of the desktop (default 1920x1080). */
	screen?: { width: number; height: number };
	/** How long a command or file call waits for a starting sandbox (default 60 s). */
	startWaitMs?: number;
	quota?: Partial<{
		maxActiveSandboxes: number;
		maxRamMb: number;
		maxSavedSnapshots: number;
	}>;
	/** Extra bearer tokens next to the default ones. */
	tokens?: Record<string, FakePrincipal>;
}

export type SandboxState =
	| "creating"
	| "ready"
	| "stopping"
	| "stopped"
	| "starting"
	| "error"
	| "deleting"
	| "deleted";

export type OperationKind =
	| "create"
	| "fork"
	| "stop"
	| "resume"
	| "recover"
	| "delete"
	| "save_snapshot";

export interface FakeOperation {
	id: string;
	sandboxId: string;
	kind: OperationKind;
	state: "pending" | "running" | "succeeded" | "failed" | "superseded";
	step: string | null;
	error: { code: string; message: string; retryable: boolean } | null;
	/** fork / save_snapshot with forceStop of a running Windows sandbox (S9 §24.8). */
	forceStop: {
		sourceStopped: boolean;
		sourceRestarted: boolean | null;
		restartError: { code: string; message: string } | null;
	} | null;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
}

export interface FakeSandbox {
	id: string;
	slug: string;
	name: string | null;
	teamId: string;
	createdBy: string | null;
	createdByKey: string | null;
	template: string;
	size: string;
	vcpu: number;
	memoryMb: number;
	state: SandboxState;
	health: "ok" | "degraded";
	activity: "busy" | "idle" | "unknown";
	stopReason: string | null;
	error: { code: string; message: string } | null;
	origin:
		| { kind: "template" }
		| { kind: "snapshot"; snapshot: string | null; snapshotId: string }
		| { kind: "fork"; sandboxId: string };
	labels: Record<string, string>;
	env: Record<string, string>;
	ttlSeconds: number | null;
	deadlineAt: Date | null;
	idleTimeoutSeconds: number | null;
	activeOperationId: string | null;
	createdAt: Date;
	readyAt: Date | null;
	stoppedAt: Date | null;
	deletedAt: Date | null;
	updatedAt: Date;
	seq: number;
}

export type CommandStatus =
	| "starting"
	| "running"
	| "exited"
	| "killed"
	| "timed_out"
	| "lost"
	| "failed_to_start";

/** Append-only bytes of one output stream. */
export class ByteLog {
	#buf = Buffer.alloc(1024);
	#size = 0;

	get size(): number {
		return this.#size;
	}

	append(data: Uint8Array): void {
		if (this.#size + data.length > this.#buf.length) {
			const next = Buffer.alloc(
				Math.max(this.#buf.length * 2, this.#size + data.length),
			);
			this.#buf.copy(next, 0, 0, this.#size);
			this.#buf = next;
		}
		this.#buf.set(data, this.#size);
		this.#size += data.length;
	}

	slice(from: number, to: number): Buffer {
		return this.#buf.subarray(from, Math.min(to, this.#size));
	}
}

export interface FakeCommand {
	id: string;
	sandboxId: string;
	mode: "sync" | "stream" | "detached";
	command: string | null;
	argv: string[] | null;
	cwd: string;
	user: string;
	env: Record<string, string>;
	tags: Record<string, string>;
	timeoutSeconds: number | null;
	status: CommandStatus;
	exitCode: number | null;
	signal: string | null;
	reason: string | null;
	pid: number;
	outputTruncated: string | null;
	createdBy: string | null;
	createdByKey: string | null;
	createdAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
	stdout: ByteLog;
	stderr: ByteLog;
	/** First byte still held (retention); tests may move it to force `truncated`. */
	availableFrom: { stdout: number; stderr: number };
	ended: boolean;
	seq: number;
	timers: Set<NodeJS.Timeout>;
	waiters: Set<() => void>;
}

export interface FakePort {
	port: number;
	access: "token" | "sso" | "public";
	hostRewrite: "preserve" | "localhost";
	appProtocol: "http1" | "h2c";
	createdAt: Date;
	token: string | null;
}

export interface FakeListeningPort {
	port: number;
	addresses: string[];
	process: string;
	user: string;
}

export interface FakeSnapshot {
	id: string;
	name: string;
	teamId: string;
	state: "creating" | "ready" | "failed" | "deleting";
	sourceSandboxId: string | null;
	template: string | null;
	size: string | null;
	consistency: "quiesced" | "powered_off" | "crash" | null;
	error: { code: string; message: string } | null;
	createdAt: Date;
	readyAt: Date | null;
	/** Copy of the sandbox files (host path). */
	dir: string;
	seq: number;
}

export interface FakeDesktopAction {
	sandboxId: string;
	actions: Record<string, unknown>[];
	coordinateSpace: { width: number; height: number } | null;
	screenshot: Record<string, unknown> | null;
}

export interface FakeDesktopState {
	/** Every accepted POST /desktop/actions, in order. */
	actions: FakeDesktopAction[];
	/** Every accepted GET /desktop/screenshot (query as sent). */
	screenshots: { sandboxId: string; query: Record<string, string> }[];
	/** Links issued by POST /desktop/links. */
	links: { sandboxId: string; url: string }[];
	/** Screen of the sandboxes that differ from `defaultScreen`. */
	screens: Map<string, { width: number; height: number }>;
	defaultScreen: { width: number; height: number };
	cursors: Map<string, { x: number; y: number }>;
	clipboards: Map<string, string>;
}

export interface FakeTemplate {
	slug: string;
	name: string;
	os: "linux" | "windows";
	enabled: boolean;
	defaultSize: string;
	allowedSizes: string[];
	loginUser: string;
	capabilities: string[];
	version: string | null;
}

export interface FakeSize {
	slug: string;
	vcpu: number;
	memoryMb: number;
}

export interface IdempotencyRecord {
	hash: string;
	/** What the first request created (resource ids). */
	result: Record<string, string>;
}

export interface FakeState {
	/** Mutable: creating/starting -> ready delay. */
	readyAfterMs: number;
	/** Mutable: the restart after a forced stop fails with this (S9 §24.8). */
	forceStopRestartError: { code: string; message: string } | null;
	sandboxes: Map<string, FakeSandbox>;
	operations: Map<string, FakeOperation>;
	commands: Map<string, FakeCommand>;
	/** Hosted ports by sandbox id. */
	ports: Map<string, Map<number, FakePort>>;
	/** What listens in the guest, by sandbox id (set by tests). */
	listening: Map<string, FakeListeningPort[]>;
	snapshots: Map<string, FakeSnapshot>;
	desktop: FakeDesktopState;
	templates: FakeTemplate[];
	sizes: FakeSize[];
	/** Names `environment` may take on create. */
	environments: Set<string>;
	/** The operator turned public ports off (403 public_disabled). */
	publicPortsDisabled: boolean;
	idempotency: Map<string, IdempotencyRecord>;
	/** Host directory with one subdirectory per sandbox. */
	filesRoot: string;
	/** The files of a sandbox (guest `/` is its directory). */
	fs(sandboxId: string): SandboxFs;
}

export type FakeEnv = {
	Variables: {
		principal: FakePrincipal;
		token: string;
		requestId: string;
		/** Parsed JSON body of the request (undefined when it had none). */
		json: unknown;
	};
};

export type FakeApp = Hono<FakeEnv>;

/** What the route modules share. */
export interface Fake {
	opts: Required<
		Omit<FakeApiOptions, "tokens" | "quota" | "screen" | "readyAfterMs">
	> & {
		quota: {
			maxActiveSandboxes: number;
			maxRamMb: number;
			maxSavedSnapshots: number;
		};
	};
	state: FakeState;
	script: FakeScript;
	tokens: Map<string, FakePrincipal>;
	journal: string[];
	contractErrors: string[];
	contract: Contract;
	bus: EventEmitter;
	/** Aborted by close(): ends every wait and stream. */
	closed: AbortSignal;
	newId(prefix: string): string;
	/** A number that grows with every call (order of lists). */
	nextSeq(): number;
	/** Runs `fn` later; cancelled by close(). */
	later(ms: number, fn: () => void): NodeJS.Timeout;
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	/**
	 * Resolves true when `pred` holds (checked now and after every change), false
	 * on timeout or abort. With `script.silent` it only ends on abort.
	 */
	waitUntil(
		pred: () => boolean,
		ms: number,
		signal?: AbortSignal,
	): Promise<boolean>;
	/** Tells the waiters that something changed. */
	notify(): void;
}

export function createState(
	filesRoot: string,
	o: {
		readyAfterMs: number;
		screen: { width: number; height: number };
	},
): FakeState {
	const fsCache = new Map<string, SandboxFs>();
	return {
		readyAfterMs: o.readyAfterMs,
		forceStopRestartError: null,
		sandboxes: new Map(),
		operations: new Map(),
		commands: new Map(),
		ports: new Map(),
		listening: new Map(),
		snapshots: new Map(),
		desktop: {
			actions: [],
			screenshots: [],
			links: [],
			screens: new Map(),
			defaultScreen: o.screen,
			cursors: new Map(),
			clipboards: new Map(),
		},
		templates: [
			{
				slug: "linux",
				name: "Linux",
				os: "linux",
				enabled: true,
				defaultSize: "2gb",
				allowedSizes: ["1gb", "2gb", "4gb", "8gb"],
				loginUser: "user",
				capabilities: ["exec", "files", "ssh"],
				version: "1.0.0",
			},
			{
				slug: "linux-desktop",
				name: "Linux desktop",
				os: "linux",
				enabled: true,
				defaultSize: "4gb",
				allowedSizes: ["4gb", "8gb"],
				loginUser: "user",
				capabilities: ["exec", "files", "ssh", "desktop"],
				version: "1.0.0",
			},
			{
				slug: "windows",
				name: "Windows",
				os: "windows",
				enabled: true,
				defaultSize: "4gb",
				allowedSizes: ["4gb", "8gb"],
				loginUser: "user",
				capabilities: ["exec", "files", "ssh", "desktop"],
				version: "1.0.0",
			},
		],
		sizes: [
			{ slug: "1gb", vcpu: 1, memoryMb: 1024 },
			{ slug: "2gb", vcpu: 2, memoryMb: 2048 },
			{ slug: "4gb", vcpu: 2, memoryMb: 4096 },
			{ slug: "8gb", vcpu: 4, memoryMb: 8192 },
		],
		environments: new Set(),
		publicPortsDisabled: false,
		idempotency: new Map(),
		filesRoot,
		fs(sandboxId) {
			let f = fsCache.get(sandboxId);
			if (!f) {
				f = new SandboxFs(join(filesRoot, sandboxId));
				fsCache.set(sandboxId, f);
			}
			return f;
		},
	};
}
