// AgentPort over the guest agent's Connect API (sbx.agent.v1 System service,
// S3 §8.1). Calls go through `AgentClient.transport(machineId)`: the client
// finds the gateway instance that owns the machine's tunnel (S2 §8.4) and
// follows 421/503 answers. Request bodies carry secrets: never log them.
import { randomUUID } from "node:crypto";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
	type AgentClient,
	AgentUnavailableError,
	classify,
	HEADER_REQUEST_ID,
} from "@sbx/agent-client";
import type { SecretFile } from "@sbx/core";
import { ErrorDetailSchema } from "@sbx/proto";
import { ClaimReason, System } from "@sbx/proto/agent/v1";
import type { QuiesceHook } from "@sbx/pve";
import { QuiesceFailed } from "../ops/snapshot-step.ts";
import {
	type AgentActivity,
	type AgentPort,
	AgentRejected,
	AgentUnavailable,
	type ClaimRequest,
} from "../ports.ts";

export interface ConnectAgentPortOptions {
	/** Receives one debug line per failed call (machine, method, code); never bodies. */
	log?: { debug(obj: object, msg: string): void };
	/**
	 * Deadline of one call, including the client's wait for the machine's
	 * route. Default 45 s.
	 */
	timeoutMs?: number;
	/** Domain of the published ports, sent as `port_domain` on every Claim. */
	portDomain?: string;
	/** SSH user CA public keys, sent as `ssh_user_ca_keys` on every Claim. */
	sshUserCaKeys?: string[];
}

/**
 * Parses an SSH user CA keys file: one public key per line; blank lines and
 * `#` comments are skipped.
 */
export function parseCaKeys(text: string): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
}

/** Mode of a secret file when S6 does not set one (S3 §10). */
const DEFAULT_SECRET_FILE_MODE = 0o440;

const CLAIM_REASONS: Record<ClaimRequest["reason"], ClaimReason> = {
	claim: ClaimReason.CLAIM,
};

/** `FailedPrecondition` -> `failed_precondition`, the wire name of a Connect code. */
function codeName(code: Code): string {
	return (Code[code] ?? "unknown")
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

function errorDetail(err: ConnectError) {
	try {
		return err.findDetails(ErrorDetailSchema)[0];
	} catch {
		return undefined;
	}
}

/**
 * Maps a failed call to a port error. Retryable (`AgentUnavailable`): no
 * route within the wait budget, Connect `unavailable`/`deadline_exceeded`,
 * connection errors, and any answer whose `ErrorDetail.retryable` is set
 * (e.g. `identity_not_ready`). Any other Connect error is the permanent
 * `AgentRejected` with the detail's code, else the Connect code name. Errors
 * that are not Connect errors pass through unchanged.
 */
function toPortError(err: unknown): unknown {
	if (err instanceof AgentUnavailableError) {
		return new AgentUnavailable(err.message, { cause: err });
	}
	if (!(err instanceof ConnectError)) {
		return classify(err) === "retry"
			? new AgentUnavailable(
					err instanceof Error ? err.message : "connection error",
					{ cause: err },
				)
			: err;
	}
	const detail = errorDetail(err);
	if (
		detail?.retryable ||
		err.code === Code.Unavailable ||
		err.code === Code.DeadlineExceeded ||
		classify(err) !== "fatal"
	) {
		return new AgentUnavailable(err.rawMessage || err.message, { cause: err });
	}
	const code = detail?.code || codeName(err.code);
	return new AgentRejected(code, `agent rejected the call: ${code}`);
}

function toProtoFile(f: SecretFile) {
	return {
		name: f.name,
		content: Buffer.from(f.contentBase64, "base64"),
		mode: f.mode ?? DEFAULT_SECRET_FILE_MODE,
		linkPath: f.linkPath ?? "",
	};
}

export class ConnectAgentPort implements AgentPort {
	readonly #client: AgentClient;
	readonly #log: ConnectAgentPortOptions["log"];
	readonly #timeoutMs: number;
	readonly #portDomain: string;
	readonly #sshUserCaKeys: string[];

	constructor(client: AgentClient, opts: ConnectAgentPortOptions = {}) {
		this.#client = client;
		this.#log = opts.log;
		this.#timeoutMs = opts.timeoutMs ?? 45_000;
		this.#portDomain = opts.portDomain ?? "";
		this.#sshUserCaKeys = [...(opts.sshUserCaKeys ?? [])];
	}

	/**
	 * Runs one System call. `requestId` goes in `Sbx-Request-Id` (mutating
	 * calls only). A failure is logged without the request and mapped by
	 * `toPortError`.
	 */
	async #call<T>(
		machineId: string,
		method: string,
		requestId: string | undefined,
		fn: (
			c: ReturnType<typeof createClient<typeof System>>,
			o: { headers?: Record<string, string>; timeoutMs: number },
		) => Promise<T>,
	): Promise<T> {
		const c = createClient(System, this.#client.transport(machineId));
		try {
			return await fn(c, {
				...(requestId === undefined
					? {}
					: { headers: { [HEADER_REQUEST_ID]: requestId } }),
				timeoutMs: this.#timeoutMs,
			});
		} catch (err) {
			const mapped = toPortError(err);
			this.#log?.debug(
				{
					machineId,
					method,
					code: (mapped as { code?: unknown } | null)?.code,
				},
				"agent call failed",
			);
			throw mapped;
		}
	}

	async claim(
		machineId: string,
		req: ClaimRequest,
		requestId: string,
	): Promise<void> {
		await this.#call(machineId, "claim", requestId, (c, o) =>
			c.claim(
				{
					reason: CLAIM_REASONS[req.reason],
					sandboxId: req.sandboxId,
					hostname: req.hostname,
					portDomain: this.#portDomain,
					sshUserCaKeys: this.#sshUserCaKeys,
					env: req.env,
					secretEnv: req.secretEnv,
					secretFiles: req.secretFiles.map(toProtoFile),
					authorizedKeys: req.authorizedKeys,
				},
				o,
			),
		);
	}

	async updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<void> {
		await this.#call(machineId, "updateEnv", requestId, (c, o) =>
			c.updateEnv({ env }, o),
		);
	}

	async updateSecrets(
		machineId: string,
		secrets: { secretEnv: Record<string, string>; secretFiles: SecretFile[] },
		requestId: string,
	): Promise<void> {
		await this.#call(machineId, "updateSecrets", requestId, (c, o) =>
			c.updateSecrets(
				{
					secretEnv: secrets.secretEnv,
					secretFiles: secrets.secretFiles.map(toProtoFile),
				},
				o,
			),
		);
	}

	async prepareStop(machineId: string): Promise<void> {
		await this.#call(machineId, "prepareStop", undefined, (c, o) =>
			c.prepareStop({}, o),
		);
	}

	async activity(machineId: string): Promise<AgentActivity> {
		const r = await this.#call(machineId, "activity", undefined, (c, o) =>
			c.activity({}, o),
		);
		return {
			runningCommands: r.runningCommands,
			openPtys: r.openPtys,
			tcpStreams: r.tcpStreams,
		};
	}

	/**
	 * Freeze = `System/Quiesce`, thaw = `System/Thaw` with the lease from the
	 * freeze. Each call gets its request id once per hook, so a retry of the
	 * same step replays the agent's cached answer instead of taking a second
	 * lease. After a freeze whose outcome is unknown (`AgentUnavailable`: the
	 * response may be lost after the agent took the lease), thaw asks
	 * `System/Info` for the active lease and thaws it; a failed lookup leaves
	 * the lease to the agent's watchdog, which thaws it at the deadline.
	 *
	 * A thaw answered with `auto_thawed` means the watchdog released the guest
	 * before the snapshot was done: the snapshot is not consistent, so thaw
	 * rejects with `QuiesceFailed`. The outcome of the first Thaw that reached
	 * the agent is kept on the hook: callers retry a failed thaw (S1 retries it
	 * three times), and every later thaw rethrows that `QuiesceFailed` or
	 * resolves when it was clean. Only a thaw that did not reach the agent
	 * (unavailable, rejected) stays retryable with the same lease and request
	 * id. Thaw without a successful freeze does nothing.
	 */
	quiesceHook(machineId: string, leaseMs: number): QuiesceHook {
		const freezeId = randomUUID();
		const thawId = randomUUID();
		let leaseId: string | undefined;
		// A freeze failed without a known outcome: the agent may hold a lease.
		let freezeUnknown = false;
		// Set once a Thaw reached the agent: undefined = not thawed yet, null = clean.
		let thawOutcome: QuiesceFailed | null | undefined;
		return {
			freeze: async () => {
				try {
					const r = await this.#call(machineId, "quiesce", freezeId, (c, o) =>
						c.quiesce({ leaseMs }, o),
					);
					leaseId = r.leaseId;
				} catch (err) {
					if (err instanceof AgentUnavailable) freezeUnknown = true;
					throw err;
				}
				freezeUnknown = false;
				thawOutcome = undefined;
			},
			thaw: async () => {
				if (thawOutcome !== undefined) {
					if (thawOutcome !== null) throw thawOutcome;
					return;
				}
				if (leaseId === undefined && freezeUnknown) {
					leaseId = await this.#activeLease(machineId);
					freezeUnknown = false;
				}
				if (leaseId === undefined) return;
				const lease = leaseId;
				const r = await this.#call(machineId, "thaw", thawId, (c, o) =>
					c.thaw({ leaseId: lease }, o),
				);
				if (!r.autoThawed) {
					thawOutcome = null;
					return;
				}
				const at = r.autoThawedAt
					? timestampDate(r.autoThawedAt).toISOString()
					: "unknown time";
				thawOutcome = new QuiesceFailed(
					`quiesce lease ${lease} of machine ${machineId} expired: the agent auto-thawed the guest at ${at}`,
				);
				throw thawOutcome;
			},
		};
	}

	/**
	 * Returns the id of the agent's active quiesce lease, or undefined when
	 * none is active or the agent cannot be asked (its watchdog thaws then).
	 */
	async #activeLease(machineId: string): Promise<string | undefined> {
		try {
			const r = await this.#call(machineId, "info", undefined, (c, o) =>
				c.info({}, o),
			);
			return r.quiesce?.active && r.quiesce.leaseId !== ""
				? r.quiesce.leaseId
				: undefined;
		} catch {
			return undefined;
		}
	}
}
