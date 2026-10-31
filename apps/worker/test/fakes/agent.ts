// Recording fake of the guest agent RPC (S3) with injectable failures.
import type { SecretFile } from "@sbx/core";
import type { QuiesceHook } from "@sbx/pve";
import {
	type AgentActivity,
	type AgentPort,
	AgentRejected,
	AgentUnavailable,
	type ClaimRequest,
	type DesktopConfiguration,
	type PrepareStopResult,
	type QuiesceHookOpts,
} from "../../src/ports.ts";

export type AgentFailure = "unavailable" | { rejected: string };

export type AgentMethod =
	| "configureDesktop"
	| "claim"
	| "updateEnv"
	| "updateSecrets"
	| "updateSshCa"
	| "prepareStop"
	| "freeze"
	| "thaw"
	| "activity";

export interface AgentCall {
	method: AgentMethod;
	machineId: string;
	requestId?: string;
	args?: unknown;
}

const IDLE: AgentActivity = { runningCommands: 0, openPtys: 0, tcpStreams: 0 };

export function failureError(f: AgentFailure): Error {
	return f === "unavailable"
		? new AgentUnavailable()
		: new AgentRejected(f.rejected);
}

export class FakeAgent implements AgentPort {
	readonly calls: AgentCall[] = [];
	/** Activity per machine (default all zero). */
	readonly activityOf = new Map<string, AgentActivity>();
	/** `secretFilesWiped` of the PrepareStop answer. */
	secretFilesWiped = false;
	/** Test control: freeze/thaw/snapshot order across fakes, when a test shares one list. */
	trace: string[] | undefined;
	/** Runs after a successful thaw of a quiesce hook (e.g. a watchdog event). */
	onThaw: ((machineId: string) => Promise<void>) | undefined;
	readonly #failures = new Map<
		AgentMethod,
		{ failure: AgentFailure; times: number }
	>();

	/** The next `times` calls of `method` fail (`Infinity` for always). */
	fail(method: AgentMethod, failure: AgentFailure, times = 1): void {
		this.#failures.set(method, { failure, times });
	}

	clearFailures(): void {
		this.#failures.clear();
	}

	callsOf(method: AgentMethod): AgentCall[] {
		return this.calls.filter((c) => c.method === method);
	}

	#record(call: AgentCall): void {
		this.calls.push(call);
		const f = this.#failures.get(call.method);
		if (f && f.times > 0) {
			f.times -= 1;
			throw failureError(f.failure);
		}
	}

	async configureDesktop(
		machineId: string,
		args: DesktopConfiguration,
		requestId: string,
	): Promise<void> {
		this.#record({ method: "configureDesktop", machineId, args, requestId });
	}
	async claim(
		machineId: string,
		req: ClaimRequest,
		requestId: string,
	): Promise<void> {
		this.#record({ method: "claim", machineId, requestId, args: req });
	}

	async updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<void> {
		this.#record({ method: "updateEnv", machineId, requestId, args: env });
	}

	async updateSecrets(
		machineId: string,
		secrets: { secretEnv: Record<string, string>; secretFiles: SecretFile[] },
		requestId: string,
	): Promise<void> {
		this.#record({
			method: "updateSecrets",
			machineId,
			requestId,
			args: secrets,
		});
	}

	async updateSshCa(machineId: string, requestId: string): Promise<void> {
		this.#record({ method: "updateSshCa", machineId, requestId });
	}

	async prepareStop(machineId: string): Promise<PrepareStopResult> {
		this.#record({ method: "prepareStop", machineId });
		return { secretFilesWiped: this.secretFilesWiped };
	}

	quiesceHook(
		machineId: string,
		leaseMs: number,
		opts?: QuiesceHookOpts,
	): QuiesceHook {
		// As the real hook: a thaw without a held lease does nothing.
		let frozen = false;
		return {
			freeze: async () => {
				this.#record({
					method: "freeze",
					machineId,
					args: { leaseMs, ...opts },
				});
				frozen = true;
				this.trace?.push(
					`agent.quiesce(fs=${opts?.fs ?? true}, wipe=${opts?.wipeSecretFiles ?? false})`,
				);
			},
			thaw: async () => {
				if (!frozen) return;
				frozen = false;
				this.#record({ method: "thaw", machineId });
				this.trace?.push("agent.thaw");
				await this.onThaw?.(machineId);
			},
		};
	}

	async activity(machineId: string): Promise<AgentActivity> {
		this.#record({ method: "activity", machineId });
		return { ...(this.activityOf.get(machineId) ?? IDLE) };
	}
}
