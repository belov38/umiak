import { expect, it } from "vitest";
import {
	assertQemuResources,
	QemuGuestIo,
	qemuArguments,
} from "../src/qemu.ts";

it("refuses unavailable KVM, insufficient RAM/disk and non-Linux hosts before build", () => {
	const good = {
		platform: "linux",
		kvm: true,
		freeBytes: 32 * 1024 ** 3,
		memoryBytes: 8 * 1024 ** 3,
	};
	expect(() => assertQemuResources(good)).not.toThrow();
	for (const bad of [
		{ platform: "darwin" },
		{ kvm: false },
		{ freeBytes: 1024 },
		{ memoryBytes: 1024 },
	])
		expect(() => assertQemuResources({ ...good, ...bad })).toThrow();
});
it("uses local QGA/QMP, explicit KVM, readonly layer and no network on replay", () => {
	const args = qemuArguments({
		disk: "/tmp/disk.qcow2",
		seed: "/tmp/seed.raw",
		layer: "/tmp/layer.raw",
		qga: "/tmp/qga",
		qmp: "/tmp/qmp",
		network: false,
	});
	expect(args).toContain("q35,accel=kvm");
	expect(args.join(" ")).toContain(
		"file=/tmp/layer.raw,format=raw,if=virtio,readonly=on",
	);
	expect(args).toContain("none");
	expect(args.join(" ")).not.toContain("accel=tcg");
	expect(args.join(" ")).toContain("org.qemu.guest_agent.0");
});
it("runs guest-exec and decodes status through the same GuestIo contract", async () => {
	const calls: { command: string; args: Record<string, unknown> }[] = [];
	let polls = 0;
	const io = new QemuGuestIo(async (command, args) => {
		calls.push({ command, args });
		if (command === "guest-exec") return { pid: 12 };
		if (command === "guest-exec-status")
			return ++polls === 1
				? { exited: false }
				: {
						exited: true,
						exitcode: 0,
						"out-data": Buffer.from("done").toString("base64"),
						"err-data": "",
					};
		return {};
	}, 0);
	expect(
		await io.exec(["sh", "-s"], { input: "secret on stdin", timeoutMs: 1000 }),
	).toMatchObject({ exitCode: 0, stdout: "done", stderr: "" });
	expect(calls[0]).toEqual({
		command: "guest-exec",
		args: {
			path: "sh",
			arg: ["-s"],
			"capture-output": true,
			"input-data": Buffer.from("secret on stdin").toString("base64"),
		},
	});
	expect(await io.ping()).toBe(true);
});
it("reads QGA files by offset and closes handles on failures", async () => {
	const calls: string[] = [];
	const io = new QemuGuestIo(async (c) => {
		calls.push(c);
		if (c === "guest-file-open") return 42;
		if (c === "guest-file-read")
			return { "buf-b64": Buffer.from("slice").toString("base64") };
		return {};
	});
	expect((await io.readFile("/tmp/x", 2, 5)).toString()).toBe("slice");
	expect(calls).toEqual([
		"guest-file-open",
		"guest-file-seek",
		"guest-file-read",
		"guest-file-close",
	]);
	await expect(io.readFile("/tmp/x", -1, 2)).rejects.toThrow();
});

it("synchronizes a local QGA connection before accepting its command response", async () => {
	const { createServer } = await import("node:net");
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { unixCommand } = await import("../src/qemu.ts");
	const dir = await mkdtemp(join(tmpdir(), "qga-"));
	const socket = join(dir, "rpc");
	const calls: string[] = [];
	const server = createServer((conn) => {
		let pending = "";
		conn.on("data", (data) => {
			pending += data.toString().replace(/^�/, "");
			for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
				const request = JSON.parse(pending.slice(0, i));
				pending = pending.slice(i + 1);
				calls.push(request.execute);
				const reply =
					request.execute === "guest-sync-delimited"
						? request.arguments.id
						: { pid: 4 };
				conn.write(`${JSON.stringify({ return: reply })}\n`);
			}
		});
	});
	try {
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		expect(
			await unixCommand(socket, "guest-exec", {
				path: "echo",
				arg: ["fixture"],
			}),
		).toEqual({ pid: 4 });
		expect(calls).toEqual(["guest-sync-delimited", "guest-exec"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
it("closes QGA file handles even when reads fail", async () => {
	const calls: string[] = [];
	const io = new QemuGuestIo(async (command) => {
		calls.push(command);
		if (command === "guest-file-open") return 3;
		if (command === "guest-file-read") throw Error("read failed");
		return {};
	});
	await expect(io.readFile("/tmp/x", 0, 5)).rejects.toThrow("read failed");
	expect(calls.at(-1)).toBe("guest-file-close");
});

it("records a serial console and pairs capture DHCP identity with local-seed NoCloud", async () => {
	const { CAPTURE_MAC } = await import("../src/qemu.ts");
	const options = {
		disk: "/tmp/disk",
		seed: "/tmp/seed",
		qga: "/tmp/qga",
		qmp: "/tmp/qmp",
		network: true,
		serial: "/tmp/serial.log",
	};
	const args = qemuArguments(options);
	expect(args).toContain("file:/tmp/serial.log");
	expect(args).toContain(`user,model=virtio-net-pci,mac=${CAPTURE_MAC}`);
	expect(args).toContain("type=1,serial=ds=nocloud;dsmode=local");
	expect(qemuArguments({ ...options, network: false })).toContain(
		"type=1,serial=ds=nocloud;dsmode=local",
	);
	expect(() =>
		qemuArguments({ ...options, serial: "/tmp/evil,option" }),
	).toThrow();
});
it("prints bounded last serial lines even when QGA never responds", async () => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { serialTail } = await import("../src/qemu.ts");
	const root = await mkdtemp(join(tmpdir(), "serial-tail-"));
	try {
		const path = join(root, "serial.log");
		await writeFile(
			path,
			`${"old line\n".repeat(20000)}apt failed: no route\n`,
		);
		const tail = serialTail(path);
		expect(tail).toContain("apt failed: no route");
		expect(tail.length).toBeLessThan(64 * 1024);
		expect(serialTail(join(root, "absent"))).toContain("unavailable");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
