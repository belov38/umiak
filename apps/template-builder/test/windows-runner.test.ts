import { type ExecResult, PveApiError, type PveClient } from "@sbx/pve";
import { FakePve } from "@sbx/pve/testing";
import { describe, expect, it } from "vitest";
import {
	type GuestIo,
	StepFailedError,
	StepTimeoutError,
} from "../src/runner.ts";
import {
	networkUp,
	rebootWindows,
	runWindowsStep,
} from "../src/windows/runner.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const MISSING = new PveApiError(
	500,
	"failed to open file 'C:\\sbx-build\\logs\\x.exit' (mode: 'r'): The system cannot find the file specified.",
);

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
}

/** Fake Windows guest: the log grows by one chunk per `schtasks /query`. */
function fakeWindows(o: FakeOpts = {}) {
	const chunks = o.chunks ?? [];
	const calls: string[][] = [];
	const reads: { path: string; offset: number }[] = [];
	let queries = 0;
	let started = false;
	let exitFile = o.staleExit;
	const log = () =>
		Buffer.concat(chunks.slice(0, Math.min(queries, chunks.length)));
	const io: GuestIo = {
		async exec(cmd) {
			calls.push(cmd);
			const custom = o.onExec?.(cmd, calls.length);
			if (custom) return custom;
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
				if (finished && "exit" in o && o.exit !== undefined) exitFile = o.exit;
				const status = finished ? (o.statusAfter ?? "Ready") : "Running";
				return ok(`"\\${cmd[3]}","N/A","${status}"\r\n`);
			}
			return ok();
		},
		async readFile(path, offset, count) {
			reads.push({ path, offset });
			if (path.endsWith(".exit")) {
				if (exitFile === undefined) throw MISSING;
				return Buffer.from(exitFile);
			}
			if (path.endsWith(".log")) return log().subarray(offset, offset + count);
			return Buffer.alloc(0);
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
			"(Get-Volume -FileSystemLabel SBXBUILD).DriveLetter",
		]);
		const create = g.calls.find((c) => c[1] === "/create");
		expect(create).toEqual([
			"schtasks.exe",
			"/create",
			"/f",
			"/tn",
			"sbx-build-00-base",
			"/ru",
			"SYSTEM",
			"/sc",
			"once",
			"/st",
			"00:00",
			"/rl",
			"HIGHEST",
			"/tr",
			"powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\\build\\run-step.ps1 -Step 00-base",
		]);
		expect(g.calls.find((c) => c[1] === "/run")).toEqual([
			"schtasks.exe",
			"/run",
			"/tn",
			"sbx-build-00-base",
		]);
		// Stale files are removed before the task exists, the task is deleted at the end.
		const order = g.calls.map((c) => c[1] ?? c[0]);
		expect(order.indexOf("/create")).toBeGreaterThan(
			g.calls.findIndex((c) => c.at(-1)?.includes("Remove-Item")),
		);
		expect(g.calls.at(-1)).toEqual([
			"schtasks.exe",
			"/delete",
			"/f",
			"/tn",
			"sbx-build-00-base",
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
		expect(clean?.at(-1)).toContain("C:\\sbx-build\\logs\\00-base.exit");
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
			"sbx-build-30-toolchains",
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

	it("rejects an unsafe step name and a failing /create", async () => {
		const g = fakeWindows();
		await expect(
			runWindowsStep(g.io, { step: "x; calc", onLog: () => {} }),
		).rejects.toThrow(/invalid step name/);
		expect(g.calls).toHaveLength(0);

		const bad = fakeWindows({
			onExec: (cmd) =>
				cmd[1] === "/create"
					? { exitCode: 1, stdout: "", stderr: "ERROR: Access is denied." }
					: undefined,
		});
		await expect(
			runWindowsStep(bad.io, { step: "00-base", onLog: () => {}, ...fast }),
		).rejects.toThrow(/schtasks \/create failed.*Access is denied/);
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

describe("rebootWindows", () => {
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
				net0: `virtio=${MAC},bridge=sbx0,firewall=1,link_down=1`,
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
			`virtio=${MAC},bridge=sbx0,firewall=1,link_down=0`,
		);
		const put = pve.calls.find((c) => c.method === "PUT");
		expect(put?.path).toBe("/nodes/pve/qemu/560/config");
		expect(put?.params).toEqual({
			net0: `virtio=${MAC},bridge=sbx0,firewall=1,link_down=0`,
		});
	});

	it("adds link_down=0 when net0 has no link_down", async () => {
		const pve = setup("10.88.0.57");
		const vm = pve.vms.get(560);
		if (vm) vm.config.net0 = `virtio=${MAC},bridge=sbx0,firewall=1`;
		await networkUp(pve as unknown as PveClient, "pve", 560, MAC, {
			pollMs: 1,
		});
		expect(vm?.config.net0).toBe(
			`virtio=${MAC},bridge=sbx0,firewall=1,link_down=0`,
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
