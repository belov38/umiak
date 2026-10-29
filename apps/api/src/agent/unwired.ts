// The production AgentApi until the S3 agent proto is wired: every RPC
// fails with AgentUnavailableError (503 agent_unavailable), `/files*` goes
// through AgentClient.fetch, capabilities come from the tunnel registry.
// ConnectAgentApi replaces it after S3 lands (global decision 3).
import {
	type AgentClient,
	type AgentFetchInit,
	AgentUnavailableError,
} from "@sbx/agent-client";
import type pg from "pg";
import type {
	AgentApi,
	AgentAttachEvent,
	AgentCommandInfo,
	AgentFileInfo,
	AgentListResult,
	AgentMakeDirResult,
	AgentPort,
	AgentReadiness,
	AgentStartResult,
} from "./types.ts";

export class UnwiredAgentApi implements AgentApi {
	readonly #client: AgentClient;
	readonly #pool: Pick<pg.Pool, "query">;

	constructor(agentClient: AgentClient, pool: Pick<pg.Pool, "query">) {
		this.#client = agentClient;
		this.#pool = pool;
	}

	/** `tunnel.tunnel_sessions.capabilities`; [] without a session or while NULL. */
	async capabilities(machineId: string): Promise<string[]> {
		const r = await this.#pool.query<{ capabilities: string[] | null }>(
			"SELECT capabilities FROM tunnel.tunnel_sessions WHERE machine_id = $1",
			[machineId],
		);
		return r.rows[0]?.capabilities ?? [];
	}

	requireCapability(
		machineId: string,
		capability: string,
		signal?: AbortSignal,
	): Promise<void> {
		return this.#client.requireCapability(machineId, capability, signal);
	}

	files(
		machineId: string,
		path: string,
		init: AgentFetchInit,
	): Promise<Response> {
		return this.#client.fetch(machineId, path, init);
	}

	attach(machineId: string): AsyncIterable<AgentAttachEvent> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(new AgentUnavailableError(machineId)),
			}),
		};
	}

	start(machineId: string): Promise<AgentStartResult> {
		return unwired(machineId);
	}
	sendInput(machineId: string): Promise<{ applied: boolean }> {
		return unwired(machineId);
	}
	update(machineId: string): Promise<void> {
		return unwired(machineId);
	}
	signal(machineId: string): Promise<AgentCommandInfo> {
		return unwired(machineId);
	}
	kill(machineId: string): Promise<AgentCommandInfo> {
		return unwired(machineId);
	}
	get(machineId: string): Promise<AgentCommandInfo> {
		return unwired(machineId);
	}
	stat(machineId: string): Promise<AgentFileInfo> {
		return unwired(machineId);
	}
	list(machineId: string): Promise<AgentListResult> {
		return unwired(machineId);
	}
	makeDir(machineId: string): Promise<AgentMakeDirResult> {
		return unwired(machineId);
	}
	move(machineId: string): Promise<AgentFileInfo> {
		return unwired(machineId);
	}
	chmod(machineId: string): Promise<AgentFileInfo> {
		return unwired(machineId);
	}
	remove(machineId: string): Promise<{ existed: boolean }> {
		return unwired(machineId);
	}
	listPorts(machineId: string): Promise<AgentPort[]> {
		return unwired(machineId);
	}
	updateEnv(machineId: string): Promise<AgentReadiness> {
		return unwired(machineId);
	}
	updateSecrets(machineId: string): Promise<AgentReadiness> {
		return unwired(machineId);
	}
}

function unwired<T>(machineId: string): Promise<T> {
	return Promise.reject(new AgentUnavailableError(machineId));
}
