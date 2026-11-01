import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, PveClient } from "@umiak/pve";
import { QgaExecStatusLostError } from "@umiak/pve";
import { FakePve } from "@umiak/pve/testing";
import { describe, expect, it } from "vitest";
import {
	type GuestIo,
	StepFailedError,
	StepTimeoutError,
} from "../src/runner.ts";
import {
	networkUp,
	readGuestFiles,
	rebootWindows,
	runWindowsStep,
} from "../src/windows/runner.ts";
import {
	type GuestFilesRequest,
	guestFilesAnswer,
	guestFilesRequest,
} from "./fakes.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

/** Script of a powershell.exe -EncodedCommand call, "" for any other command. */
function decoded(cmd: string[]): string {
	if (cmd[0] !== "powershell.exe" || !cmd.includes("-EncodedCommand"))
		return "";
	return Buffer.from(String(cmd.at(-1)), "base64").toString("utf16le");
}

interface FakeOpts {
	/** Log content visible after the Nth task status query (1-based), as cumulative chunks. */
	chunks?: Buffer[];
	/** Exit file content once the chunks are consumed; undefined = never written. */
	exit?: string | undefined;
	/** Task status after the chunks are consumed while no exit file exists. */
	statusAfter?: string;
	/** Exit file content already there before the step starts (a stale earlier run). */
	staleExit?: string;
	driveLetter?: string;
	onExec?: (cmd: string[], n: number) => ExecResult | undefined;
	/** `/run` starts the task, then the call fails (lost reply). */
	runError?: Error;
	/** Log bytes that appear together with the exit file. */
	tail?: Buffer;
}

/**
 * Fake Windows guest: the log grows by one chunk per `schtasks /query`; the log and the exit file
 * are read through one PowerShell exec per read, never through QGA file-read.
 */
function fakeWindows(o: FakeOpts = {}) {
	const chunks = o.chunks ?? [];
	const calls: string[][] = [];
	const reads: GuestFilesRequest[] = [];
	let queries = 0;
	let started = false;
	let exitFile = o.staleExit;
	let tail: Buffer = Buffer.alloc(0);
	const log = () =>
		started
			? Buffer.concat([
					...chunks.slice(0, Math.min(queries, chunks.length)),
					tail,
				])
			: undefined;
	const io: GuestIo = {
		async exec(cmd) {
			calls.push(cmd);
			const custom = o.onExec?.(cmd, calls.length);
			if (custom) return custom;
			const read = guestFilesRequest(cmd);
			if (read) {
				reads.push(read);
				return guestFilesAnswer(read, exitFile, log());
			}
			if (cmd[0] === "powershell.exe") {
				const script = cmd.at(-1) ?? "";
				if (script.includes("Get-Volume"))
					return ok(`${o.driveLetter ?? "d"}\r\n`);
				if (script.includes("Remove-Item")) {
					exitFile = undefined;
					return ok();
				}
			}
			if (cmd[0] === "schtasks.exe" && cmd[1] === "/run") {
				started = true;
				if (o.runError) throw o.runError;
			}
			if (cmd[0] === "schtasks.exe" && cmd[1] === "/query") {
				if (!started)
					return { exitCode: 1, stdout: "", stderr: "ERROR: not found" };
				queries++;
				const finished = queries > chunks.length;
				if (finished && "exit" in o && o.exit !== undefined) {
					exitFile = o.exit;
					tail = o.tail ?? tail;
				}
				const status = finished ? (o.statusAfter ?? "Ready") : "Running";
				return ok(`"\\${cmd[3]}","N/A","${status}"\r\n`);
			}
			return ok();
		},
		async readFile(path) {
			throw new Error(`file-read is not used on Windows: ${path}`);
		},
		async ping() {
			return true;
		},
	};
	return { io, calls, reads };
}

const fast = { pollMs: 1, startCheckMs: 20 };

describe("runWindowsStep", () => {
	it("runs a step to exit 0 and streams the log", async () => {
		const g = fakeWindows({
			chunks: [Buffer.from("one\n"), Buffer.from("two\n")],
			exit: "0",
		});
		const out: string[] = [];
		await runWindowsStep(g.io, {
			step: "00-base",
			onLog: (c) => out.push(c),
			...fast,
		});
		expect(out.join("")).toBe("one\ntwo\n");

		const drive = g.calls.find((c) => c.at(-1)?.includes("Get-Volume"));
		expect(drive).toEqual([
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"(Get-Volume -FileSystemLabel UMIAKBUILD).DriveLetter",
		]);
		// One exec registers the task: normal priority (schtasks /create gives 7), no time limit.
		const create = g.calls.filter((c) =>
			decoded(c).includes("Register-ScheduledTask"),
		);
		expect(create).toHaveLength(1);
		const reg = decoded(create[0] as string[]);
		expect(reg).toContain("-TaskName 'umiak-build-00-base'");
		expect(reg).toContain("-Execute 'powershell.exe'");
		expect(reg).toContain(
			"-Argument '-NoProfile -ExecutionPolicy Bypass -File D:\\build\\run-step.ps1 -Step 00-base'",
		);
		expect(reg).toMatch(
			/-UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest/,
		);
		expect(reg).toMatch(/New-ScheduledTaskSettingsSet [^\n]*-Priority 4/);
		expect(reg).toMatch(/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
		expect(reg).toContain("-Force");
		expect(g.calls.some((c) => c[1] === "/create")).toBe(false);
		expect(g.calls.find((c) => c[1] === "/run")).toEqual([
			"schtasks.exe",
			"/run",
			"/tn",
			"umiak-build-00-base",
		]);
		// Stale files are removed before the task exists, the task is deleted at the end.
		expect(
			g.calls.findIndex((c) => decoded(c).includes("Register-ScheduledTask")),
		).toBeGreaterThan(
			g.calls.findIndex((c) => c.at(-1)?.includes("Remove-Item")),
		);
		expect(g.calls.at(-1)).toEqual([
			"schtasks.exe",
			"/delete",
			"/f",
			"/tn",
			"umiak-build-00-base",
		]);
	});

	it("ignores an exit file left by an earlier attempt", async () => {
		const g = fakeWindows({
			chunks: [Buffer.from("fresh\n")],
			exit: "0",
			staleExit: "7",
		});
		await runWindowsStep(g.io, { step: "00-base", onLog: () => {}, ...fast });
		const clean = g.calls.find((c) => c.at(-1)?.includes("Remove-Item"));
		expect(clean?.at(-1)).toContain("C:\\umiak-build\\logs\\00-base.exit");
		// Remove-Item of missing files leaves $? false, which -Command turns into exit 1.
		expect(clean?.at(-1)).toMatch(/; exit 0$/);
	});

	it("non-zero exit throws StepFailedError with tail", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("");
		const g = fakeWindows({ chunks: [Buffer.from(lines)], exit: "3" });
		const err = await runWindowsStep(g.io, {
			step: "10-system",
			onLog: () => {},
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepFailedError);
		expect(err.exitStatus).toBe(3);
		expect(err.tail).toHaveLength(200);
		expect(err.tail.at(-1)).toBe("line 299");
		expect(g.calls.at(-1)?.[1]).toBe("/delete");
	});

	it("UTF-8 split across reads printed once", async () => {
		const bytes = Buffer.from("caf\u00e9 \u2713 ok\n");
		// Cut inside the two-byte e-acute and inside the three-byte check mark.
		const cutA = bytes.indexOf(0xc3) + 1;
		const cutB = bytes.indexOf(0xe2) + 1;
		const g = fakeWindows({
			chunks: [
				bytes.subarray(0, cutA),
				bytes.subarray(cutA, cutB),
				bytes.subarray(cutB),
			],
			exit: "0",
		});
		const out: string[] = [];
		await runWindowsStep(g.io, {
			step: "00-base",
			onLog: (c) => out.push(c),
			...fast,
		});
		expect(out.join("")).toBe("caf\u00e9 \u2713 ok\n");
		expect(out.join("")).not.toContain("\ufffd");
	});

	it("reads the exit file and the log in one exec per poll, never through file-read", async () => {
		const g = fakeWindows({
			chunks: [Buffer.from("one\n"), Buffer.from("two\n")],
			exit: "0",
		});
		await runWindowsStep(g.io, { step: "00-base", onLog: () => {}, ...fast });
		const polls = g.reads.filter((r) => r.exit !== "");
		expect(polls.length).toBeGreaterThan(2);
		for (const r of polls) {
			expect(r.exit).toBe("C:\\umiak-build\\logs\\00-base.exit");
			expect(r.log).toBe("C:\\umiak-build\\logs\\00-base.log");
			expect(r.count).toBe(1024 * 1024);
		}
		const cmd = g.calls.find((c) => guestFilesRequest(c));
		expect(cmd?.slice(0, -1)).toEqual([
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
		]);
		// The exit file is read before the log: a seen exit means the log is complete.
		const text = Buffer.from(String(cmd?.at(-1)), "base64").toString("utf16le");
		expect(text.indexOf("Open($exitPath")).toBeGreaterThan(0);
		expect(text.indexOf("Open($exitPath")).toBeLessThan(
			text.indexOf("Open($logPath"),
		);
		expect(text).toContain("'ReadWrite, Delete'");
	});

	it("an exit seen with a big log drains the log to its end", async () => {
		const big = Buffer.alloc(2.5 * 1024 * 1024, "a");
		big.write("\n", big.length - 1);
		const g = fakeWindows({
			chunks: [Buffer.from("start\n")],
			exit: "0",
			tail: big,
		});
		let got = 0;
		await runWindowsStep(g.io, {
			step: "00-base",
			onLog: (c) => {
				got += Buffer.byteLength(c);
			},
			...fast,
		});
		expect(got).toBe(6 + big.length);
		// The poll that saw the exit plus log-only reads to the end.
		const last = g.reads.findLastIndex((r) => r.exit !== "");
		const after = g.reads.slice(last + 1);
		expect(after.length).toBeGreaterThanOrEqual(2);
		expect(after.every((r) => r.exit === "")).toBe(true);
		expect(after.at(-1)?.offset).toBe(6 + big.length);
	});

	it("a failing read script fails the step with its error", async () => {
		const g = fakeWindows({
			onExec: (cmd) =>
				guestFilesRequest(cmd)
					? { exitCode: 1, stdout: "", stderr: "Access to the path is denied." }
					: undefined,
		});
		await expect(
			runWindowsStep(g.io, { step: "00-base", onLog: () => {}, ...fast }),
		).rejects.toThrow(/Access to the path is denied/);
		expect(g.calls.at(-1)?.[1]).toBe("/delete");
	});

	it("timeout throws StepTimeoutError and deletes the task", async () => {
		const g = fakeWindows({
			chunks: Array.from({ length: 100_000 }, () => Buffer.from("tick\n")),
		});
		const err = await runWindowsStep(g.io, {
			step: "30-toolchains",
			onLog: () => {},
			timeoutMs: 40,
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepTimeoutError);
		expect(err.tail.length).toBeGreaterThan(0);
		expect(g.calls.some((c) => c[1] === "/end")).toBe(true);
		expect(g.calls.at(-1)).toEqual([
			"schtasks.exe",
			"/delete",
			"/f",
			"/tn",
			"umiak-build-30-toolchains",
		]);
	});

	it("a task that ended without an exit file fails the step", async () => {
		const g = fakeWindows({ chunks: [Buffer.from("boom\n")] });
		const err = await runWindowsStep(g.io, {
			step: "00-base",
			onLog: () => {},
			timeoutMs: 10_000,
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepFailedError);
		expect(err.message).toContain("without writing");
		expect(err.tail).toEqual(["boom"]);
	});

	it("rejects an unsafe step name and a failing task registration", async () => {
		const g = fakeWindows();
		await expect(
			runWindowsStep(g.io, { step: "x; calc", onLog: () => {} }),
		).rejects.toThrow(/invalid step name/);
		expect(g.calls).toHaveLength(0);

		const bad = fakeWindows({
			onExec: (cmd) =>
				decoded(cmd).includes("Register-ScheduledTask")
					? { exitCode: 1, stdout: "", stderr: "Access is denied." }
					: undefined,
		});
		await expect(
			runWindowsStep(bad.io, { step: "00-base", onLog: () => {}, ...fast }),
		).rejects.toThrow(/registering the task failed.*Access is denied/);
		expect(bad.calls.at(-1)?.[1]).toBe("/delete");
	});

	it("a lost /run reply does not start the task twice", async () => {
		const g = fakeWindows({
			chunks: [Buffer.from("x\n")],
			exit: "0",
			runError: Object.assign(new Error("read ECONNRESET"), {
				code: "ECONNRESET",
			}),
		});
		const out: string[] = [];
		await runWindowsStep(g.io, {
			step: "00-base",
			onLog: (c) => out.push(c),
			...fast,
		});
		expect(g.calls.filter((c) => c[1] === "/run")).toHaveLength(1);
		expect(out.join("")).toContain("x\n");
	});

	it("fails when /run never started the task", async () => {
		const g = fakeWindows({
			onExec: (cmd) => {
				if (cmd[1] === "/run")
					throw Object.assign(new Error("read ECONNRESET"), {
						code: "ECONNRESET",
					});
				return undefined;
			},
		});
		await expect(
			runWindowsStep(g.io, { step: "00-base", onLog: () => {}, ...fast }),
		).rejects.toThrow(/task did not start/);
		expect(g.calls.filter((c) => c[1] === "/run")).toHaveLength(1);
	});
});

/** pwsh comes from mise.toml (`powershell`); `PWSH=<path>` overrides it. */
const PWSH = process.env.PWSH ?? "pwsh";

/** Runs the powershell.exe commands of readGuestFiles in local pwsh. */
const pwshIo: GuestIo = {
	async exec(cmd) {
		const r = spawnSync(PWSH, cmd.slice(1), { encoding: "utf8" });
		return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
	},
	async readFile(path) {
		throw new Error(`file-read is not used on Windows: ${path}`);
	},
	async ping() {
		return true;
	},
};

describe("task registration script (pwsh)", () => {
	it("parses without errors", async () => {
		const g = fakeWindows({ chunks: [Buffer.from("x\n")], exit: "0" });
		await runWindowsStep(g.io, { step: "00-base", onLog: () => {}, ...fast });
		const reg = g.calls
			.map(decoded)
			.find((t) => t.includes("Register-ScheduledTask"));
		expect(reg).toBeDefined();
		const r = spawnSync(
			PWSH,
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count",
			],
			{ input: reg, encoding: "utf8" },
		);
		expect(r.stdout + r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("readGuestFiles script (pwsh)", () => {
	it("missing files read as no exit and an empty log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "umiak-read-"));
		try {
			const r = await readGuestFiles(pwshIo, {
				exit: join(dir, "x.exit"),
				log: join(dir, "nodir", "x.log"),
				offset: 0,
				count: 1024,
			});
			expect(r).toEqual({ exit: null, size: 0, data: Buffer.alloc(0) });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the exit file and a log chunk from an offset", async () => {
		const dir = mkdtempSync(join(tmpdir(), "umiak-read-"));
		try {
			const log = Buffer.from("caf\u00e9 \u2713 ok\n");
			writeFileSync(join(dir, "x.exit"), "0\r\n");
			writeFileSync(join(dir, "x.log"), log);
			const r = await readGuestFiles(pwshIo, {
				exit: join(dir, "x.exit"),
				log: join(dir, "x.log"),
				offset: 4,
				count: 3,
			});
			expect(r.exit).toBe("0\r\n");
			expect(r.size).toBe(log.length);
			// Cut inside the check mark: raw bytes, the caller decodes.
			expect(r.data).toEqual(log.subarray(4, 7));
			const end = await readGuestFiles(pwshIo, {
				log: join(dir, "x.log"),
				offset: log.length,
				count: 3,
			});
			expect(end).toEqual({
				exit: null,
				size: log.length,
				data: Buffer.alloc(0),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a log locked by another process reads as empty, not as an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "umiak-read-"));
		const path = join(dir, "x.log");
		writeFileSync(path, "held\n");
		// .NET on Unix takes an exclusive flock for FileShare.None.
		const holder = spawn(PWSH, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$h = [System.IO.File]::Open('${path}', 'Open', 'ReadWrite', 'None'); 'locked'; [Console]::Out.Flush(); Start-Sleep -Seconds 30`,
		]);
		try {
			await new Promise<void>((resolve, reject) => {
				holder.stdout.on("data", (d: Buffer) => {
					if (d.toString().includes("locked")) resolve();
				});
				holder.on("exit", () => reject(new Error("holder exited")));
			});
			const r = await readGuestFiles(pwshIo, {
				log: path,
				offset: 0,
				count: 64,
			});
			expect(r).toEqual({ exit: null, size: 0, data: Buffer.alloc(0) });
		} finally {
			holder.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rebootWindows", () => {
	it("retries a lost exec status while reading the boot time before the reboot", async () => {
		let boot = "2026-10-31T10:00:00.0000000+00:00";
		let first = true;
		let rebooted = false;
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd[0] === "shutdown.exe") {
					rebooted = true;
					boot = "2026-10-31T10:05:00.0000000+00:00";
					return ok();
				}
				if (first) {
					first = false;
					throw new QgaExecStatusLostError(
						598,
						4492,
						new Error("PID lld does not exist"),
					);
				}
				return ok(`${boot}\r\n`);
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await rebootWindows(io, { pollMs: 1, timeoutMs: 5000 });
		expect(rebooted).toBe(true);
	});

	it("reboot waits for a new boot time", async () => {
		let boot = "2026-10-31T10:00:00.0000000+00:00";
		let pings = 0;
		let rebooted = false;
		const calls: string[][] = [];
		const io: GuestIo = {
			async exec(cmd) {
				calls.push(cmd);
				if (cmd[0] === "shutdown.exe") {
					rebooted = true;
					return ok();
				}
				if (cmd.at(-1)?.includes("LastBootUpTime")) {
					// The old system still answers for two polls after the reboot call.
					if (rebooted && ++pings > 2)
						boot = "2026-10-31T10:05:00.0000000+00:00";
					return ok(`${boot}\r\n`);
				}
				return ok();
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await rebootWindows(io, { pollMs: 1, timeoutMs: 5000 });
		expect(calls.find((c) => c[0] === "shutdown.exe")).toEqual([
			"shutdown.exe",
			"/r",
			"/t",
			"0",
		]);
		// First read, then reads on the old system, then the new boot time.
		expect(pings).toBeGreaterThan(2);
	});

	it("times out when the boot time never changes", async () => {
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd.at(-1)?.includes("LastBootUpTime")) return ok("same\n");
				return ok();
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await expect(
			rebootWindows(io, { pollMs: 1, timeoutMs: 30 }),
		).rejects.toThrow(/boot time unchanged/);
	});

	it("keeps polling through agent errors while the guest restarts", async () => {
		let n = 0;
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd[0] === "shutdown.exe") throw new Error("agent went away");
				if (cmd.at(-1)?.includes("LastBootUpTime")) {
					n++;
					if (n === 1) return ok("old\n");
					if (n === 2) throw new Error("guest agent is not running");
					return ok("new\n");
				}
				return ok();
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await rebootWindows(io, { pollMs: 1, timeoutMs: 5000 });
		expect(n).toBe(3);
	});
});

describe("networkUp", () => {
	const MAC = "BC:24:11:AA:BB:CC";
	function setup(ip: string) {
		const pve = new FakePve();
		pve.vms.set(560, {
			config: {
				net0: `virtio=${MAC},bridge=umiak0,firewall=1,link_down=1`,
			},
			status: "running",
			firewall: { rules: [], ipsets: {} },
		});
		pve.ipam.push({ vmid: 560, mac: MAC, ip });
		return pve;
	}

	it("clears link_down, keeps the rest of net0 and waits for an IPv4", async () => {
		const pve = setup("10.88.0.57");
		await networkUp(pve as unknown as PveClient, "pve", 560, MAC, {
			pollMs: 1,
		});
		expect(pve.vms.get(560)?.config.net0).toBe(
			`virtio=${MAC},bridge=umiak0,firewall=1,link_down=0`,
		);
		const put = pve.calls.find((c) => c.method === "PUT");
		expect(put?.path).toBe("/nodes/pve/qemu/560/config");
		expect(put?.params).toEqual({
			net0: `virtio=${MAC},bridge=umiak0,firewall=1,link_down=0`,
		});
	});

	it("adds link_down=0 when net0 has no link_down", async () => {
		const pve = setup("10.88.0.57");
		const vm = pve.vms.get(560);
		if (vm) vm.config.net0 = `virtio=${MAC},bridge=umiak0,firewall=1`;
		await networkUp(pve as unknown as PveClient, "pve", 560, MAC, {
			pollMs: 1,
		});
		expect(vm?.config.net0).toBe(
			`virtio=${MAC},bridge=umiak0,firewall=1,link_down=0`,
		);
	});

	it("fails when no address in the subnet shows up", async () => {
		const pve = setup("192.168.1.9");
		await expect(
			networkUp(pve as unknown as PveClient, "pve", 560, MAC, {
				pollMs: 1,
				timeoutMs: 20,
			}),
		).rejects.toThrow(/no IPv4 in 10\.88\.0\.0\/24/);
	});

	it("refuses a net0 with another MAC", async () => {
		const pve = setup("10.88.0.57");
		await expect(
			networkUp(pve as unknown as PveClient, "pve", 560, "BC:24:11:00:00:09"),
		).rejects.toThrow(/expected MAC/);
		expect(pve.calls.some((c) => c.method === "PUT")).toBe(false);
	});
});
