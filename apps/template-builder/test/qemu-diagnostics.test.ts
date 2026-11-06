import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { QemuVM } from "../src/qemu.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("retains QMP events, stderr and serial context when QGA cannot bootstrap", async () => {
	const root = await mkdtemp(join(tmpdir(), "qemu-diag-"));
	const socket = join(root, "qmp");
	const child = Object.assign(new EventEmitter(), {
		exitCode: null as number | null,
		signalCode: null,
		stderr: new PassThrough(),
	});
	vi.mocked(spawn).mockImplementation(((_program: string, args: string[]) => {
		const serial = args[args.indexOf("-serial") + 1]?.slice(5);
		if (!serial) throw Error("serial missing");
		writeFileSync(serial, "cloud-init: apt failed: network unreachable\n");
		return child as unknown as ChildProcess;
	}) as typeof spawn);
	const server = createServer((conn) => {
		conn.write('{"QMP":{"version":{}}}\n');
		conn.on("data", () => conn.write('{"return":{}}\n{"event":"RESET"}\n'));
	});
	let vm: QemuVM | undefined;
	try {
		await new Promise<void>((resolve) =>
			server.listen(`${socket}.events`, resolve),
		);
		vm = new QemuVM({
			disk: join(root, "disk"),
			seed: join(root, "seed"),
			qga: join(root, "qga"),
			qmp: socket,
			network: true,
			diagnosticsDirectory: join(root, "logs"),
		});
		child.stderr.write("fixture QEMU stderr\n");
		await vi.waitFor(() =>
			expect(
				readFileSync(join(root, "logs/qmp-events.jsonl"), "utf8"),
			).toContain('"event":"RESET"'),
		);
		await expect(vm.ready(0)).rejects.toThrow(
			/no QGA response.*QEMU stderr: fixture QEMU stderr[\s\S]*Serial tail:[\s\S]*network unreachable/,
		);
		expect(readFileSync(join(root, "logs/qemu-stderr.log"), "utf8")).toContain(
			"fixture QEMU stderr",
		);
		writeFileSync(
			join(root, "logs/serial.log"),
			"network diagnostics\nUMIAK_CAPTURE_NETWORK_FAILED\n",
		);
		await expect(vm.ready(1000)).rejects.toThrow(
			"Capture network bootstrap failed before apt",
		);
		vi.spyOn(vm.guest, "ping").mockResolvedValue(true);
		vi.spyOn(vm.guest, "readFile").mockResolvedValue(
			Buffer.from("cloud-init trace\n"),
		);
		await vm.collectDiagnostics();
		expect(
			readFileSync(join(root, "logs/cloud-init-output.log"), "utf8"),
		).toContain("cloud-init trace");
	} finally {
		child.exitCode = 0;
		await vm?.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	}
});
