import { type ChildProcess, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	mkdirSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { access, statfs } from "node:fs/promises";
import { createConnection } from "node:net";
import { platform, totalmem } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@umiak/pve";
import type { GuestIo } from "./runner.ts";

export const CAPTURE_MAC = "52:54:00:25:00:01";

export function serialTail(path: string): string {
	try {
		const size = statSync(path).size,
			fd = openSync(path, "r"),
			bytes = Buffer.alloc(Math.min(size, 64 * 1024));
		try {
			readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
			return bytes.toString().split("\n").slice(-60).join("\n");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "(serial log unavailable)";
	}
}

type Rpc = (
	command: string,
	args: Record<string, unknown>,
	timeoutMs?: number,
) => Promise<unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export function assertQemuResources(facts: {
	platform: string;
	kvm: boolean;
	freeBytes: number;
	memoryBytes: number;
}): void {
	if (facts.platform !== "linux" || !facts.kvm)
		throw Error(
			"QEMU image capture requires Linux with usable /dev/kvm; no TCG fallback",
		);
	if (facts.memoryBytes < 6 * 1024 ** 3)
		throw Error("QEMU capture needs at least 6 GiB host RAM");
	if (facts.freeBytes < 24 * 1024 ** 3)
		throw Error(
			"QEMU capture needs at least 24 GiB free disk for inputs and fresh offline replay",
		);
}
/** A new connection is synchronized before every request; errors never echo arguments. */
export function unixCommand(
	socketPath: string,
	command: string,
	args: Record<string, unknown> = {},
	timeoutMs = 30_000,
	protocol: "qga" | "qmp" = "qga",
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = Buffer.alloc(0);
		let phase = "handshake";
		let done = false;
		const sync = randomInt(1, 2 ** 31);
		const finish = (err?: Error, result?: unknown) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			if (err) reject(err);
			else resolve(result);
		};
		const timer = setTimeout(
			() => finish(Error(`QEMU ${command} timed out`)),
			timeoutMs,
		);
		const send = (execute: string, arguments_: Record<string, unknown>) =>
			socket.write(`${JSON.stringify({ execute, arguments: arguments_ })}\n`);
		socket.on("error", () =>
			finish(Error(`QEMU ${command} socket unavailable`)),
		);
		socket.on("close", () => {
			if (!done) finish(Error(`QEMU ${command} connection closed`));
		});
		socket.on("connect", () => {
			if (protocol === "qga") {
				socket.write(Buffer.from([0xff]));
				send("guest-sync-delimited", { id: sync });
			}
		});
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([
				buffer,
				typeof chunk === "string" ? Buffer.from(chunk) : chunk,
			]);
			if (buffer.length > 4 * 1024 * 1024) {
				finish(Error("QEMU response exceeds limit"));
				return;
			}
			for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
				let line = buffer.subarray(0, end);
				buffer = buffer.subarray(end + 1);
				if (line[0] === 0xff) line = line.subarray(1);
				let response: Record<string, unknown>;
				try {
					response = JSON.parse(line.toString());
				} catch {
					finish(Error("Invalid QEMU JSON response"));
					return;
				}
				if (response.error) {
					const message = (response.error as { desc?: string }).desc || "";
					finish(
						Error(
							command === "guest-file-open" && /no such file/i.test(message)
								? "ENOENT: guest file does not exist"
								: `QEMU ${command} failed`,
						),
					);
					return;
				}
				if (phase === "handshake") {
					if (protocol === "qmp" && response.QMP) {
						phase = "capabilities";
						send("qmp_capabilities", {});
					} else if (protocol === "qga" && response.return === sync) {
						phase = "command";
						send(command, args);
					}
				} else if (phase === "capabilities" && "return" in response) {
					phase = "command";
					send(command, args);
				} else if (phase === "command" && "return" in response) {
					finish(undefined, response.return);
					return;
				}
			}
		});
	});
}
export class QemuGuestIo implements GuestIo {
	lastPingError = "no QGA response";
	private readonly rpc: Rpc;
	private readonly pollMs: number;
	constructor(rpc: Rpc, pollMs = 250) {
		this.rpc = rpc;
		this.pollMs = pollMs;
	}
	async ping(): Promise<boolean> {
		try {
			await this.rpc("guest-ping", {}, 5000);
			return true;
		} catch (error) {
			this.lastPingError =
				error instanceof Error ? error.message : String(error);
			return false;
		}
	}
	async exec(
		cmd: string[],
		o: { input?: string; timeoutMs?: number } = {},
	): Promise<ExecResult> {
		if (!cmd[0]) throw Error("Guest command is required");
		const deadline = Date.now() + (o.timeoutMs ?? 60_000);
		const started = (await this.rpc(
			"guest-exec",
			{
				path: cmd[0],
				arg: cmd.slice(1),
				"capture-output": true,
				...(o.input !== undefined
					? { "input-data": Buffer.from(o.input).toString("base64") }
					: {}),
			},
			Math.max(1, deadline - Date.now()),
		)) as { pid: number };
		if (!Number.isSafeInteger(started.pid) || started.pid < 1)
			throw Error("Invalid QGA process identity");
		for (;;) {
			if (Date.now() >= deadline) throw Error("Guest command timed out");
			const result = (await this.rpc(
				"guest-exec-status",
				{ pid: started.pid },
				Math.max(1, deadline - Date.now()),
			)) as {
				exited: boolean;
				exitcode?: number;
				signal?: number;
				"out-data"?: string;
				"err-data"?: string;
				"out-truncated"?: boolean;
				"err-truncated"?: boolean;
			};
			if (result.exited) {
				if (result["out-truncated"] || result["err-truncated"])
					throw Error("Guest command output truncated");
				return {
					exitCode: result.exitcode ?? 128 + (result.signal ?? 1),
					stdout: Buffer.from(result["out-data"] ?? "", "base64").toString(),
					stderr: Buffer.from(result["err-data"] ?? "", "base64").toString(),
				};
			}
			await sleep(this.pollMs);
		}
	}
	async readFile(path: string, offset: number, count: number): Promise<Buffer> {
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			count > 1024 * 1024
		)
			throw Error("Invalid guest file range");
		const handle = await this.rpc("guest-file-open", { path, mode: "r" });
		if (!Number.isSafeInteger(handle)) throw Error("Invalid guest file handle");
		try {
			await this.rpc("guest-file-seek", { handle, offset, whence: 0 });
			const result = (await this.rpc("guest-file-read", { handle, count })) as {
				"buf-b64": string;
			};
			return Buffer.from(result["buf-b64"], "base64");
		} finally {
			await this.rpc("guest-file-close", { handle });
		}
	}
}
export function qemuArguments(o: {
	disk: string;
	seed: string;
	layer?: string;
	qga: string;
	qmp: string;
	network: boolean;
	serial?: string;
	diagnosticsDirectory?: string;
}): string[] {
	for (const value of [
		o.disk,
		o.seed,
		o.qga,
		o.qmp,
		...(o.layer ? [o.layer] : []),
		...(o.serial ? [o.serial] : []),
	])
		if (
			!value.startsWith("/") ||
			value.includes(",") ||
			[...value].some((c) => (c.codePointAt(0) ?? 0) < 32)
		)
			throw Error(
				"QEMU paths must be absolute and free of drive-option separators",
			);
	return [
		"-machine",
		"q35,accel=kvm",
		"-cpu",
		"host",
		"-m",
		"4096",
		"-smp",
		"2",
		"-nodefaults",
		"-display",
		"none",
		"-serial",
		`file:${o.serial ?? `${o.qga}.serial.log`}`,
		"-device",
		"virtio-serial-pci",
		"-chardev",
		`socket,path=${o.qga},server=on,wait=off,id=qga`,
		"-device",
		"virtserialport,chardev=qga,name=org.qemu.guest_agent.0",
		"-qmp",
		`unix:${o.qmp},server=on,wait=off`,
		"-qmp",
		`unix:${o.qmp}.events,server=on,wait=off`,
		"-drive",
		`file=${o.disk},format=qcow2,if=virtio,discard=unmap`,
		"-drive",
		`file=${o.seed},format=raw,if=virtio,readonly=on`,
		...(o.layer
			? ["-drive", `file=${o.layer},format=raw,if=virtio,readonly=on`]
			: []),
		"-smbios",
		`type=1,serial=ds=nocloud;dsmode=${o.network ? "net" : "local"}`,
		...(o.network
			? ["-nic", `user,model=virtio-net-pci,mac=${CAPTURE_MAC}`]
			: ["-nic", "none"]),
	];
}
export class QemuVM {
	private diagnostic = "";
	private closed = false;
	private monitor?: ReturnType<typeof createConnection>;
	private monitorTimer?: ReturnType<typeof setTimeout>;
	readonly diagnosticsDirectory: string;
	readonly guest: QemuGuestIo;
	readonly process: ChildProcess;
	private readonly options: Parameters<typeof qemuArguments>[0];
	constructor(options: Parameters<typeof qemuArguments>[0]) {
		this.diagnosticsDirectory =
			options.diagnosticsDirectory ?? `${options.qga}.diagnostics`;
		mkdirSync(this.diagnosticsDirectory, { recursive: true, mode: 0o700 });
		options = {
			...options,
			serial: join(this.diagnosticsDirectory, "serial.log"),
		};
		this.options = options;
		for (const name of ["serial.log", "qemu-stderr.log", "qmp-events.jsonl"])
			appendFileSync(join(this.diagnosticsDirectory, name), "");
		appendFileSync(
			join(this.diagnosticsDirectory, "qemu-arguments.json"),
			JSON.stringify(qemuArguments(options)),
		);
		this.process = spawn("qemu-system-x86_64", qemuArguments(options), {
			stdio: ["ignore", "ignore", "pipe"],
		});
		this.process.on("error", (err) => {
			this.diagnostic = err.message;
			appendFileSync(
				join(this.diagnosticsDirectory, "qemu-stderr.log"),
				`${err.message}\n`,
			);
		});
		this.process.stderr?.on("data", (data) => {
			this.diagnostic = (this.diagnostic + String(data)).slice(-4096);
			appendFileSync(join(this.diagnosticsDirectory, "qemu-stderr.log"), data);
		});
		this.recordQmp();
		this.guest = new QemuGuestIo((command, args, timeout) =>
			unixCommand(options.qga, command, args, timeout),
		);
	}
	private recordQmp(): void {
		if (
			this.closed ||
			this.process.exitCode !== null ||
			this.process.signalCode !== null
		)
			return;
		const socket = createConnection(`${this.options.qmp}.events`);
		this.monitor = socket;
		let pending = "";
		let queried = false;
		socket.on("data", (data) => {
			pending += data.toString();
			if (pending.length > 4 * 1024 ** 2) {
				socket.destroy();
				return;
			}
			for (
				let end = pending.indexOf("\n");
				end >= 0;
				end = pending.indexOf("\n")
			) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				appendFileSync(
					join(this.diagnosticsDirectory, "qmp-events.jsonl"),
					`${line}\n`,
				);
				try {
					const response = JSON.parse(line);
					if (response.return && !queried) {
						queried = true;
						socket.write(`${JSON.stringify({ execute: "query-status" })}\n`);
					}
					if (response.QMP)
						socket.write(
							`${JSON.stringify({ execute: "qmp_capabilities" })}\n`,
						);
				} catch {
					socket.destroy();
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			if (!this.closed) {
				this.monitorTimer = setTimeout(() => this.recordQmp(), 500);
				this.monitorTimer.unref();
			}
		});
	}
	async collectDiagnostics(): Promise<void> {
		if (!(await this.guest.ping())) return;
		for (const path of [
			"/var/log/cloud-init.log",
			"/var/log/cloud-init-output.log",
		]) {
			try {
				const bytes = await this.guest.readFile(path, 0, 1024 ** 2);
				appendFileSync(
					join(
						this.diagnosticsDirectory,
						path.slice(path.lastIndexOf("/") + 1),
					),
					bytes,
				);
			} catch {
				/* Serial output remains available when QGA cannot read guest logs. */
			}
		}
	}
	async ready(timeoutMs = 300_000): Promise<void> {
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			if (this.process.exitCode !== null || this.process.signalCode !== null)
				throw Error(
					`QEMU exited: ${this.diagnostic}\nSerial tail:\n${serialTail(join(this.diagnosticsDirectory, "serial.log"))}`,
				);
			if (await this.guest.ping()) return;
			await sleep(500);
		}
		throw Error(
			`QEMU guest agent did not become ready: ${this.guest.lastPingError}; QEMU stderr: ${this.diagnostic || "(empty)"}\nDiagnostics: ${this.diagnosticsDirectory}\nSerial tail:\n${serialTail(join(this.diagnosticsDirectory, "serial.log"))}`,
		);
	}
	async close(): Promise<void> {
		this.closed = true;
		clearTimeout(this.monitorTimer);
		this.monitor?.destroy();
		if (this.process.exitCode !== null || this.process.signalCode !== null)
			return;
		try {
			await unixCommand(this.options.qmp, "quit", {}, 5000, "qmp");
		} catch {
			this.process.kill("SIGTERM");
		}
		await Promise.race([
			new Promise((resolve) => this.process.once("exit", resolve)),
			sleep(5000),
		]);
		if (this.process.exitCode === null && this.process.signalCode === null)
			this.process.kill("SIGKILL");
	}
}
export async function probeQemu(workDirectory: string): Promise<void> {
	const fs = await statfs(workDirectory);
	let kvm = true;
	try {
		await access("/dev/kvm", constants.R_OK | constants.W_OK);
	} catch {
		kvm = false;
	}
	assertQemuResources({
		platform: platform(),
		kvm,
		freeBytes: Number(fs.bavail) * Number(fs.bsize),
		memoryBytes: totalmem(),
	});
	// A readable device alone is insufficient; the accelerator must initialize.
	const socketPath = `${workDirectory}/probe.qmp`;
	const child = spawn(
		"qemu-system-x86_64",
		[
			"-machine",
			"q35,accel=kvm",
			"-nodefaults",
			"-display",
			"none",
			"-S",
			"-qmp",
			`unix:${socketPath},server=on,wait=off`,
		],
		{ stdio: "ignore" },
	);
	let failure: Error | undefined;
	child.on("error", (err) => {
		failure = err;
	});
	try {
		const end = Date.now() + 15_000;
		for (;;) {
			if (failure || child.exitCode !== null)
				throw Error("QEMU KVM startup probe failed");
			try {
				const result = (await unixCommand(
					socketPath,
					"query-kvm",
					{},
					1000,
					"qmp",
				)) as { enabled: boolean };
				if (!result.enabled) throw Error("KVM not enabled");
				return;
			} catch {
				if (Date.now() >= end) throw Error("QEMU KVM startup probe timed out");
				await sleep(100);
			}
		}
	} finally {
		child.kill("SIGKILL");
	}
}
