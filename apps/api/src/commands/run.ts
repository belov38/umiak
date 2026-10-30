// Starting a command (S7 §9.1): scope (route), touchApiActivity, the wait
// for ready, capabilities, the command row (under the Idempotency-Key the
// row and its commandId are found again), `Process/Start` with a requestId
// derived from the key, `markCommandRunning`. A repeat with the same key
// never starts a second process: the agent's Start is idempotent by
// commandId, and a command that already ended is not started again.
import { randomUUID } from "node:crypto";
import {
	COMMAND_SCOPE,
	type Command,
	type CommandSpec,
	idempotencyPrincipal,
	uuidv5,
} from "@sbx/core";
import {
	AgentCallError,
	agentErrorToHttp,
	isAgentOutcomeUnknown,
} from "../agent/errors.ts";
import type { AgentCommandInfo, AgentCommandSpec } from "../agent/types.ts";
import type { AuthContext } from "../auth/principal.ts";
import type { ApiDeps } from "../deps.ts";
import { ApiError } from "../http/errors.ts";
import { isTerminalStatus, publicCommandId } from "../map/command.ts";
import {
	type StartCommandBody,
	SYNC_DEFAULT_TIMEOUT_SECONDS,
} from "../schemas/command.ts";
import { commandResultOf } from "./attach.ts";
import { waitUntilReady } from "./wait-ready.ts";

export interface StartedCommand {
	command: Command;
	machineId: string;
	/** The answer of Process/Start; null for a replay of an ended command. */
	info: AgentCommandInfo | null;
	/** The same Idempotency-Key and body started this command before. */
	replayed: boolean;
}

/** Agent requestId of a start: UUIDv5 of the key (§5.7), else a new UUID. */
export function startRequestId(
	auth: AuthContext,
	idemKey: string | undefined,
): string {
	if (idemKey === undefined) return randomUUID();
	return uuidv5(
		`${idempotencyPrincipal(auth.principal)}:${COMMAND_SCOPE}:${idemKey}`,
	);
}

/** The timeout of the process: sync defaults to 60 s (§9.1). */
export function effectiveTimeout(b: StartCommandBody): number | null {
	if (b.timeoutSeconds !== undefined) return b.timeoutSeconds;
	return (b.mode ?? "sync") === "sync" ? SYNC_DEFAULT_TIMEOUT_SECONDS : null;
}

function agentSpec(b: StartCommandBody): AgentCommandSpec {
	const spec: AgentCommandSpec = {
		cwd: b.cwd ?? "",
		env: b.env ?? {},
		user: b.user ?? "user",
		stdin: b.stdin ?? false,
		timeoutMs: (effectiveTimeout(b) ?? 0) * 1000,
		tags: b.tags ?? {},
	};
	if (b.command !== undefined) spec.shell = b.command;
	else if (b.argv) spec.argv = b.argv;
	return spec;
}

function coreSpec(b: StartCommandBody, requestId: string): CommandSpec {
	return {
		cmd: b.command ?? "",
		argv: b.argv ?? null,
		cwd: b.cwd ?? null,
		env: b.env ?? {},
		mode: b.mode ?? "sync",
		timeoutSeconds: effectiveTimeout(b),
		requestId,
		user: b.user ?? "user",
		tags: b.tags ?? {},
	};
}

/**
 * 409 unless the command runs on the sandbox's current machine (after a
 * reprovision its process and output are gone).
 */
export function requireSameMachine(
	command: Pick<Command, "machineId">,
	machineId: string,
): void {
	if (command.machineId !== machineId) {
		throw new ApiError(
			409,
			"invalid_state",
			"the command ran on an earlier machine of this sandbox; its process and output are gone",
			{ details: { reason: "machine_replaced" } },
		);
	}
}

/** `agent_unavailable` of a Start whose outcome is unknown (§9.1). */
function startUnavailable(commandId: string, keyed: boolean): ApiError {
	const id = publicCommandId(commandId);
	return new ApiError(
		503,
		"agent_unavailable",
		keyed
			? "the sandbox agent is not reachable; retry with the same Idempotency-Key (the command starts at most once)"
			: `the sandbox agent is not reachable and the command may have started; check GET .../commands/${id}`,
		{
			retryable: keyed,
			details: keyed
				? { commandId: id }
				: { commandId: id, outcome: "unknown" },
		},
	);
}

/** What to start: the command row, the agent spec and the capabilities. */
export interface StartPlan {
	/** Agent capabilities the command needs. */
	capabilities: string[];
	/** The command row (the requestId is added by the start). */
	core: Omit<CommandSpec, "requestId">;
	agent: AgentCommandSpec;
	/** Hashed with the Idempotency-Key: the validated client body. */
	hashBody: unknown;
}

/** The plan of `POST .../commands`. */
export function commandPlan(body: StartCommandBody): StartPlan {
	const { requestId: _, ...core } = coreSpec(body, "");
	return {
		capabilities:
			body.stdin === true ? ["process.v1", "process.stdin"] : ["process.v1"],
		core,
		agent: agentSpec(body),
		hashBody: body,
	};
}

/**
 * Steps 1-5 of §9.1. `ref` is the core reference of the sandbox; `body` the
 * validated request body (hashed with the key).
 */
export function startCommand(
	deps: ApiDeps,
	auth: AuthContext,
	ref: string,
	body: StartCommandBody,
	idemKey?: string,
	signal?: AbortSignal,
): Promise<StartedCommand> {
	return startPlanned(deps, auth, ref, commandPlan(body), idemKey, signal);
}

/** `startCommand` of any plan (commands, PTYs). */
export async function startPlanned(
	deps: ApiDeps,
	auth: AuthContext,
	ref: string,
	plan: StartPlan,
	idemKey?: string,
	signal?: AbortSignal,
): Promise<StartedCommand> {
	const p = auth.principal;
	const svc = deps.svc;
	const sandbox = await waitUntilReady(deps, p, ref, signal, (s) =>
		svc.touchApiActivity(s.id),
	);
	const { machineId } = await svc.resolveAgentTarget(p, sandbox.id);
	try {
		for (const cap of plan.capabilities) {
			await deps.agent.requireCapability(machineId, cap, signal);
		}
	} catch (e) {
		// Closed meanwhile (shutdown, revocation): the caller maps the reason.
		if (signal?.aborted) throw signal.reason ?? e;
		throw agentErrorToHttp(e);
	}

	const requestId = startRequestId(auth, idemKey);
	const spec: CommandSpec = { ...plan.core, requestId };
	const { command, replayed } =
		idemKey === undefined
			? {
					command: await svc.createCommand(p, sandbox.id, spec),
					replayed: false,
				}
			: await svc.createCommandWithKey(
					p,
					sandbox.id,
					spec,
					idemKey,
					plan.hashBody,
				);
	// A replay of a command of an earlier machine: its process is gone.
	requireSameMachine(command, machineId);
	if (replayed && isTerminalStatus(command.status)) {
		// Ended: Start is not repeated (an agent that lost it would run it again).
		return { command, machineId, info: null, replayed };
	}

	let info: AgentCommandInfo;
	try {
		const r = await deps.agent.start(
			machineId,
			{ commandId: command.id, spec: plan.agent },
			// Not aborted with the request: a Start cut short has an unknown outcome.
			{ requestId },
		);
		info = r.command;
	} catch (e) {
		// Unreachable, Unavailable with a detail, or DeadlineExceeded: the
		// agent may have started it.
		if (isAgentOutcomeUnknown(e)) {
			throw startUnavailable(command.id, idemKey !== undefined);
		}
		if (e instanceof AgentCallError) {
			// The agent refused it: the process never started. A row that a
			// concurrent replay already moved on is left alone.
			await svc.failCommandStart(command.id).catch(() => {});
		}
		throw agentErrorToHttp(e);
	}

	await svc.markCommandRunning(command.id, info.pid);
	// Ended already (start_failed): complete it now, a detached command may
	// never be followed.
	const result = commandResultOf(info);
	if (result !== null) await svc.completeCommand(command.id, result);
	const fresh = await svc.getCommand(p, sandbox.id, command.id);
	return { command: fresh, machineId, info, replayed };
}
