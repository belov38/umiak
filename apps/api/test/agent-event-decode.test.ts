// S3 event payloads (proto/sbx/agent/v1/events.proto) carried as Any in the
// gateway's AgentEventsRequest: decoded to protojson the core normalizer
// understands (S6 §10.2), with zero values kept (exit code 0, no commands).
import {
	create,
	type DescMessage,
	type MessageShape,
} from "@bufbuild/protobuf";
import { anyPack } from "@bufbuild/protobuf/wkt";
import { normalizeAgentEvent } from "@sbx/core";
import {
	ActivitySchema,
	ClaimAppliedSchema,
	CommandExitedSchema,
	ExitReason,
	ExitStatus,
	IdentityResetSchema,
	OutputTruncatedSchema,
	PhaseState,
	PortSchema,
	PortsChangedSchema,
	PtyClosedSchema,
	QuiesceAutoThawedSchema,
	ReadinessChangedSchema,
	Stream,
} from "@sbx/proto/agent/v1";
import { describe, expect, it } from "vitest";
import { decodePayload } from "../src/agent/event-decode.ts";

function roundTrip<D extends DescMessage>(
	type: string,
	schema: D,
	init: Parameters<typeof create<D>>[1],
) {
	const msg = create(schema, init) as MessageShape<D>;
	const payload = decodePayload(anyPack(schema, msg));
	return { payload, event: normalizeAgentEvent({ type, payload }) };
}

describe("S3 event payloads", () => {
	it("CommandExited: exit code 0 survives, status from ExitStatus", () => {
		const { payload, event } = roundTrip(
			"command.exited",
			CommandExitedSchema,
			{
				commandId: "01CMD",
				status: ExitStatus.EXITED,
				code: 0,
				reason: ExitReason.NONE,
				stdoutEnd: 12n,
				stderrEnd: 0n,
			},
		);
		expect(payload).toMatchObject({ commandId: "01CMD", code: 0 });
		expect(event).toEqual({
			kind: "command_exited",
			commandId: "01CMD",
			status: "exited",
			exitCode: 0,
			signal: null,
			reason: "none",
			outputTruncated: null,
			stdoutBytes: 12,
			stderrBytes: 0,
		});
	});

	it("CommandExited and OutputTruncated: the reason in lower case and output_truncated", () => {
		expect(
			roundTrip("command.exited", CommandExitedSchema, {
				commandId: "01O",
				status: ExitStatus.KILLED,
				code: 137,
				signal: "SIGKILL",
				reason: ExitReason.OOM,
				outputTruncated: "disk_full",
			}).event,
		).toMatchObject({
			status: "killed",
			reason: "oom",
			outputTruncated: "disk_full",
		});
		expect(
			roundTrip("output.truncated", OutputTruncatedSchema, {
				commandId: "01O",
				stream: Stream.STDOUT,
				reason: "disk_full",
			}).event,
		).toEqual({
			kind: "output_truncated",
			commandId: "01O",
			reason: "disk_full",
		});
	});

	it("CommandExited: TIMEOUT → timed_out, START_FAILED → failed_to_start", () => {
		expect(
			roundTrip("command.exited", CommandExitedSchema, {
				commandId: "01T",
				status: ExitStatus.KILLED,
				code: 143,
				signal: "SIGTERM",
				reason: ExitReason.TIMEOUT,
			}).event,
		).toMatchObject({ status: "timed_out", exitCode: 143, signal: "SIGTERM" });
		expect(
			roundTrip("command.exited", CommandExitedSchema, {
				commandId: "01S",
				status: ExitStatus.EXITED,
				code: 127,
				reason: ExitReason.START_FAILED,
			}).event,
		).toMatchObject({ status: "failed_to_start", exitCode: 127 });
	});

	it("ReadinessChanged, Activity with zeros, PortsChanged, PtyClosed, ClaimApplied, IdentityReset, QuiesceAutoThawed", () => {
		expect(
			roundTrip("readiness.changed", ReadinessChangedSchema, {
				phase: "secrets",
				state: PhaseState.PENDING,
			}).event,
		).toEqual({ kind: "phase", phase: "secrets_missing" });
		expect(
			roundTrip("readiness.changed", ReadinessChangedSchema, {
				phase: "identity",
				state: PhaseState.READY,
			}).event,
		).toEqual({ kind: "phase", phase: "pool_ready" });
		expect(
			roundTrip("activity", ActivitySchema, { runningCommands: 1 }).event,
		).toEqual({
			kind: "activity",
			runningCommands: 1,
			openPtys: 0,
			tcpStreams: 0,
			desktopStreams: 0,
		});
		expect(
			roundTrip("ports.changed", PortsChangedSchema, {
				ports: [create(PortSchema, { port: 3000, addresses: ["0.0.0.0"] })],
			}).event,
		).toMatchObject({
			kind: "ports_changed",
			listening: [{ port: 3000, addresses: ["0.0.0.0"] }],
		});
		expect(roundTrip("ports.changed", PortsChangedSchema, {}).event).toEqual({
			kind: "ports_changed",
			listening: [],
		});
		expect(
			roundTrip("pty.closed", PtyClosedSchema, {
				commandId: "01P",
				reason: ExitReason.PTY_IDLE,
			}).event,
		).toEqual({ kind: "pty_closed", commandId: "01P", reason: "pty_idle" });
		expect(
			roundTrip("claim.applied", ClaimAppliedSchema, { sandboxId: "s-1" })
				.event,
		).toEqual({ kind: "claim_applied", sandboxId: "s-1" });
		expect(
			roundTrip("identity.reset", IdentityResetSchema, { machineId: "m-1" })
				.event,
		).toEqual({ kind: "identity_reset", machineId: "m-1" });
		expect(
			roundTrip("quiesce.auto_thawed", QuiesceAutoThawedSchema, {
				leaseId: "l-1",
				by: "watchdog",
			}).event,
		).toEqual({ kind: "quiesce_watchdog_thawed" });
	});

	it("a corrupt S3 payload is stored as {@type}", () => {
		const typeUrl = "type.googleapis.com/sbx.agent.v1.CommandExited";
		expect(
			decodePayload({
				$typeName: "google.protobuf.Any",
				typeUrl,
				value: new Uint8Array([0x0a, 0x10, 0x41]),
			}),
		).toEqual({ "@type": typeUrl });
	});
});
