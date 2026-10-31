import {
	AllocatorError,
	FreezeBudgetExceededError,
	FreezeTimeoutError,
	formatSmbios1,
	NodeOpsError,
	PveApiError,
	PveTaskError,
	QgaExecStatusLostError,
	QgaTimeoutError,
	QgaUnavailableError,
	StorageFullError,
	ThawFailedError,
	TracesRemainError,
} from "@sbx/pve";
import { describe, expect, it } from "vitest";
import {
	classifyInfraError,
	InfraError,
	scrubSecrets,
} from "../src/adapters/infra-errors.ts";
import { QuiesceFailed } from "../src/ops/snapshot-step.ts";
import {
	AgentRejected,
	AgentUnavailable,
	isPermanent,
	isRetryable,
} from "../src/ports.ts";

const MACHINE = "0199a8f0-0000-7000-8000-000000000001";
const SERIAL = `sbx1:${MACHINE}:q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA`;
const SMBIOS1 = formatSmbios1({ uuid: MACHINE, serial: SERIAL });
const SERIAL_B64 = Buffer.from(SERIAL).toString("base64");

describe("scrubSecrets", () => {
	it("removes smbios1, serial= values, the base64 payload and the raw payload", () => {
		const text = [
			`smbios1=${SMBIOS1} next`,
			`'serial=${SERIAL_B64},base64=1'`,
			`{"smbios1":"${SMBIOS1}"}`,
			`value '${SERIAL_B64}' invalid`,
			`raw ${SERIAL} end`,
		].join(" | ");
		const out = scrubSecrets(text);
		expect(out).not.toContain(SERIAL_B64);
		expect(out).not.toContain(SERIAL);
		expect(out).not.toContain("q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA");
		expect(out).toContain("next");
		expect(out).toContain("invalid");
		expect(out).toContain("end");
	});

	it("leaves other text alone", () => {
		expect(scrubSecrets("VM 512 is running - destroy failed")).toBe(
			"VM 512 is running - destroy failed",
		);
	});
});

describe("classifyInfraError", () => {
	it("scrubs a PveApiError that echoes smbios1 and does not attach the original", () => {
		const orig = new PveApiError(400, `POST /nodes/pve/qemu: invalid format`, {
			smbios1: `value '${SMBIOS1}' does not match`,
		});
		const e = classifyInfraError(orig, "create");
		expect(e).toBeInstanceOf(InfraError);
		expect(e.message).not.toContain(SERIAL_B64);
		expect(e.message).toContain("invalid format");
		expect(e.cause).toBeUndefined();
		expect(String(e.stack)).not.toContain(SERIAL_B64);
		expect(JSON.stringify(e)).not.toContain(SERIAL_B64);
		// 400 is a permanent rejection.
		expect(isPermanent(e)).toBe(true);
		expect((e as InfraError).code).toBe("pve_rejected");
		expect((e as InfraError).status).toBe(400);
	});

	it("QGA unavailable during a snapshot is a permanent quiesce_failed", () => {
		const e = classifyInfraError(new QgaUnavailableError(512), "snapshot");
		expect(e).toBeInstanceOf(QuiesceFailed);
		expect((e as QuiesceFailed).code).toBe("quiesce_failed");
		expect(isPermanent(e)).toBe(true);
	});

	it("QGA unavailable outside a snapshot stays transient", () => {
		const e = classifyInfraError(new QgaUnavailableError(512), "qgaExec");
		expect(isRetryable(e)).toBe(true);
	});

	it("freeze budget and a QGA thaw failure are quiesce_failed", () => {
		const budget = classifyInfraError(
			new FreezeBudgetExceededError("freeze took 12000 ms"),
			"snapshot",
		);
		expect(budget).toBeInstanceOf(QuiesceFailed);
		const thaw = classifyInfraError(
			new ThawFailedError(512, new PveApiError(500, "agent timeout")),
			"snapshot",
		);
		expect(thaw).toBeInstanceOf(QuiesceFailed);
		expect(isPermanent(thaw)).toBe(true);
		expect(thaw.cause).toBeUndefined();
	});

	it("a freeze timeout is quiesce_failed and keeps the cause", () => {
		const cause = new FreezeTimeoutError(
			"freeze did not return within 30000 ms",
		);
		const e = classifyInfraError(cause, "snapshot");
		expect(e).toBeInstanceOf(QuiesceFailed);
		expect(isPermanent(e)).toBe(true);
		expect(e.cause).toBe(cause);
	});

	it("a thaw failure caused by an unavailable agent stays transient (QGA fallback)", () => {
		const cause = new AgentUnavailable();
		const e = classifyInfraError(new ThawFailedError(512, cause), "snapshot");
		expect(e).toBe(cause);
		expect(isRetryable(e)).toBe(true);
	});

	it("port errors pass through with their own retryable flag", () => {
		const rejected = new AgentRejected("quiesce_refused");
		expect(classifyInfraError(rejected, "snapshot")).toBe(rejected);
		const unavailable = new AgentUnavailable();
		expect(classifyInfraError(unavailable, "snapshot")).toBe(unavailable);
	});

	it("PveApiError: 404, 409 and lock or timeout 4xx are transient, other 4xx permanent, 5xx transient", () => {
		const t = (status: number, msg = "x") =>
			isRetryable(classifyInfraError(new PveApiError(status, msg), "start"));
		expect(t(404)).toBe(true);
		expect(t(409)).toBe(true);
		expect(
			t(400, "can't lock file '/var/lock/qemu-server/lock-512.conf'"),
		).toBe(true);
		expect(t(408, "got timeout")).toBe(true);
		expect(t(400)).toBe(false);
		expect(t(401)).toBe(false);
		expect(t(403, "Permission check failed")).toBe(false);
		// A pool-scoped token's answer for a VM that is gone: re-check on retry.
		expect(
			t(
				403,
				"GET /nodes/pve/qemu/512/config: Permission check failed (/vms/512, VM.Audit)",
			),
		).toBe(true);
		expect(t(403, "Permission check failed (/pool/sandbox, VM.Allocate)")).toBe(
			false,
		);
		expect(t(500, "VM 512 is running - destroy failed")).toBe(true);
		expect(t(503)).toBe(true);
	});

	it("TracesRemainError is transient: the verified delete is retried", () => {
		const e = classifyInfraError(
			new TracesRemainError(512, ["IPAM still has 02:01:00:00:02:00"]),
			"delete",
		);
		expect(isRetryable(e)).toBe(true);
		expect((e as InfraError).code).toBe("traces_remain");
	});

	it("delete failures seen on the host are transient", () => {
		const task = classifyInfraError(
			new PveTaskError(
				"UPID:pve:00001:destroy",
				"got no worker upid - start worker failed",
			),
			"delete",
		);
		expect(isRetryable(task)).toBe(true);
		expect((task as InfraError).code).toBe("pve_task_failed");
		const api = classifyInfraError(
			new PveApiError(
				500,
				"DELETE /nodes/pve/qemu/512: got no worker upid - start worker failed",
			),
			"delete",
		);
		expect(isRetryable(api)).toBe(true);
		const busy = classifyInfraError(
			new NodeOpsError("dhcp.leases", "busy", "lease file is being rewritten"),
			"delete",
		);
		expect(isRetryable(busy)).toBe(true);
		expect((busy as InfraError).code).toBe("node_busy");
		const traces = classifyInfraError(
			new TracesRemainError(512, [
				"DHCP lease or ethers entry for 02:01:00:00:02:00 remains",
			]),
			"delete",
		);
		expect(isRetryable(traces)).toBe(true);
	});

	it("everything else is transient", () => {
		for (const err of [
			new PveTaskError("UPID:pve:1", "start failed"),
			new QgaTimeoutError(
				500,
				"qga command 'guest-exec' failed - got timeout",
				"guest-exec",
			),
			new QgaExecStatusLostError(512, 42, new Error("gone")),
			new StorageFullError("thin pool data 90%"),
			new AllocatorError("vmid_exhausted", "no free VMID"),
			new NodeOpsError("lv.list", "internal", "lvs failed"),
			new Error("socket hang up"),
			"a string",
		]) {
			const e = classifyInfraError(err, "create");
			expect(isRetryable(e), String(err)).toBe(true);
			expect(e.cause).toBeUndefined();
		}
	});

	it("scrubs plain errors too", () => {
		const e = classifyInfraError(
			new Error(`PUT failed smbios1=${SMBIOS1}`),
			"create",
		);
		expect(e.message).not.toContain(SERIAL_B64);
	});
});
