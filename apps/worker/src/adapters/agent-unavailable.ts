// Placeholder AgentPort until S3 (decision 12): proto/sbx/agent/v1 and
// @sbx/agent-client do not exist yet. S3's Connect RPC adapter (calls through
// the gateway, S2 §8.4) replaces this class; the worker wiring only swaps the
// constructor.
import type { SecretFile } from "@sbx/core";
import type { QuiesceHook } from "@sbx/pve";
import {
	type AgentActivity,
	type AgentPort,
	AgentUnavailable,
	type ClaimRequest,
} from "../ports.ts";

function unavailable(what: string): AgentUnavailable {
	return new AgentUnavailable(`agent RPC is not available yet (S3): ${what}`);
}

/**
 * Every call fails with the transient `AgentUnavailable`, so operations that
 * need the agent wait in pg-boss retries. The quiesce hook's freeze fails the
 * same way (the snapshot step then falls back to QGA); its thaw does nothing,
 * since nothing was frozen through this port.
 */
export class UnavailableAgentPort implements AgentPort {
	async claim(
		_machineId: string,
		_req: ClaimRequest,
		_requestId: string,
	): Promise<void> {
		throw unavailable("claim");
	}

	async updateEnv(
		_machineId: string,
		_env: Record<string, string>,
		_requestId: string,
	): Promise<void> {
		throw unavailable("updateEnv");
	}

	async updateSecrets(
		_machineId: string,
		_secrets: { secretEnv: Record<string, string>; secretFiles: SecretFile[] },
		_requestId: string,
	): Promise<void> {
		throw unavailable("updateSecrets");
	}

	async updateSshCa(_machineId: string, _requestId: string): Promise<void> {
		throw unavailable("updateSshCa");
	}

	async prepareStop(_machineId: string): Promise<void> {
		throw unavailable("prepareStop");
	}

	quiesceHook(_machineId: string, _leaseMs: number): QuiesceHook {
		return {
			freeze: async () => {
				throw unavailable("quiesce");
			},
			thaw: async () => {},
		};
	}

	async activity(_machineId: string): Promise<AgentActivity> {
		throw unavailable("activity");
	}
}
