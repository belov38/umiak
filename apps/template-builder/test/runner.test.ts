import {
	type ExecResult,
	PveApiError,
	type PveClient,
	QgaTimeoutError,
} from "@umiak/pve";
import { describe, expect, it } from "vitest";
import {
	type GuestIo,
	mountSeed,
	pveGuestIo,
	rebootGuest,
	runStep,
	StepFailedError,
	StepTimeoutError,
} from "../src/runner.ts";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const showOut = (state: string, extra = "") =>
	ok(`ActiveState=${state}\nResult=success\nExecMainStatus=0\n${extra}`);

const SCRIPT = "/mnt/seed/build/steps/00-base.sh";

interface FakeOpts {
	/** Log content visible after the Nth `systemctl show` (1-based), as cumulative chunks. */
	chunks?: Buffer[];
	/** rc file content; undefined = no file. */
	rc?: string | undefined;
	/** Number of `systemctl show` answers with ActiveState=active before inactive; Infinity = never. */
	activePolls?: number;
	/** Called for each exec before the default handling; may throw or return a result. */
	onExec?: (cmd: string[], n: number) => ExecResult | undefined;
	onRead?: (path: string, n: number) => void;
	/** systemd-run starts the unit, then the call fails (lost reply). */
	startError?: Error;
	/** The unit is already gone (--collect) when it is first looked at; the whole log is readable. */
	collected?: boolean;
	/** While true, every guest file reads as missing. */
	hideFiles?: () => boolean;
}

/** Fake guest: the log grows by one chunk per `systemctl show`. */
function fakeGuest(o: FakeOpts = {}) {
	const chunks = o.chunks ?? [];
	const activePolls = o.activePolls ?? chunks.length;
	const calls: { cmd: string[]; input?: string | undefined }[] = [];
	const reads: { path: string; offset: number; count: number }[] = [];
	let shows = 0;
	let started = false;
	const log = () =>
		Buffer.concat(
			chunks.slice(
				0,
				o.collected ? chunks.length : Math.min(shows, chunks.length),
			),
		);
	const io: GuestIo = {
		async exec(cmd, opts) {
			calls.push({ cmd, input: opts?.input });
			const custom = o.onExec?.(cmd, calls.length);
			if (custom) return custom;
			if (cmd[0] === "systemd-run") {
				started = true;
				if (o.startError) throw o.startError;
				return ok();
			}
			if (cmd[0] === "systemctl" && cmd[1] === "show") {
				shows++;
				if (!started || o.collected)
					return ok(
						"LoadState=not-found\nActiveState=inactive\nResult=success\n",
					);
				return showOut(
					shows > activePolls ? "inactive" : "active",
					"LoadState=loaded\n",
				);
			}
			return ok();
		},
		async readFile(path, offset, count) {
			reads.push({ path, offset, count });
			if (o.hideFiles?.()) return Buffer.alloc(0);
			o.onRead?.(path, reads.length);
			if (path.endsWith(".rc"))
				return o.rc === undefined ? Buffer.alloc(0) : Buffer.from(o.rc);
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

/** Log output without the builder's notes about retried errors. */
const stepText = (out: string[]) =>
	out.filter((c) => !c.startsWith("[umiak-tpl]")).join("");

const netError = (msg = "read ECONNRESET", code = "ECONNRESET") =>
	Object.assign(new Error(msg), { code });

describe("runStep", () => {
	it("starts the unit with the exact argv and delivers the log in order", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("one\n"), Buffer.from("two\n")],
			rc: "0\n",
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "00-base",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(r.exitStatus).toBe(0);
		expect(r.tail).toEqual(["one", "two"]);
		expect(out.join("")).toBe("one\ntwo\n");

		const prep = g.calls[0]?.cmd;
		expect(prep?.slice(0, 2)).toEqual(["bash", "-c"]);
		// The step name is a positional argument, never part of the script text.
		expect(prep?.[2]).not.toContain("00-base");
		expect(prep?.slice(3)).toEqual(["umiak-prep", "00-base"]);
		expect(prep?.[2]).toContain("mkdir -p /var/log/umiak-build");
		expect(prep?.[2]).toContain("rm -f");

		const start = g.calls.find((c) => c.cmd[0] === "systemd-run");
		expect(start?.cmd).toEqual([
			"systemd-run",
			"--unit=umiak-build-00-base",
			"--collect",
			"--property=StandardOutput=append:/var/log/umiak-build/00-base.log",
			"--property=StandardError=append:/var/log/umiak-build/00-base.log",
			"--property=WorkingDirectory=/mnt/seed/build",
			// A single $: "$$" reaches sh unchanged in transient units and expands to its PID.
			`--property=ExecStopPost=/bin/sh -c 'echo "$EXIT_STATUS" > /var/log/umiak-build/00-base.rc'`,
			"--",
			"bash",
			SCRIPT,
		]);
		expect(g.calls.every((c) => c.input === undefined)).toBe(true);
		expect(
			g.calls.some((c) => c.cmd.join(" ").startsWith("systemctl show -p")),
		).toBe(true);
	});

	it("prints a UTF-8 character split across two reads once and intact", async () => {
		const euro = Buffer.from("€"); // e2 82 ac
		const g = fakeGuest({
			chunks: [
				Buffer.concat([Buffer.from("a "), euro.subarray(0, 2)]),
				Buffer.concat([euro.subarray(2), Buffer.from(" b\n")]),
			],
			rc: "0",
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(out.join("")).toBe("a € b\n");
		expect(out.join("")).not.toContain("�");
		expect(out.filter((c) => c.includes("€"))).toHaveLength(1);
		expect(r.tail).toEqual(["a € b"]);
	});

	it("reads the log at the byte offset of what it already consumed", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("abc"), Buffer.from("defgh")],
			rc: "0",
		});
		await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
		});
		const logReads = g.reads.filter((r) => r.path.endsWith(".log"));
		expect(logReads.map((r) => r.offset)).toEqual([0, 3, 8]);
		expect(logReads.every((r) => r.count <= 16 * 1024 * 1024)).toBe(true);
	});

	it("fails with the tail (at most 200 lines) on a non-zero rc", async () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
		const g = fakeGuest({
			chunks: [Buffer.from(`${lines.join("\n")}\ntrailing`)],
			rc: "3\n",
		});
		const err = await runStep(g.io, {
			name: "20-x",
			script: SCRIPT,
			log: () => {},
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepFailedError);
		expect(err.step).toBe("20-x");
		expect(err.exitStatus).toBe(3);
		expect(err.tail).toHaveLength(200);
		expect(err.tail[0]).toBe("line 101");
		expect(err.tail.at(-1)).toBe("trailing");
		expect(err.message).toContain("20-x");
	});

	it.each([
		["", "missing"],
		["TERM\n", "TERM"],
	])("treats an unusable rc %j as exit status -1", async (rc, what) => {
		const g = fakeGuest({
			chunks: [Buffer.from("x\n")],
			rc: rc === "" ? undefined : rc,
		});
		const err = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepFailedError);
		expect(err.exitStatus).toBe(-1);
		expect(err.message).toContain(what === "missing" ? ".rc" : what);
		expect(err.tail).toEqual(["x"]);
	});

	it("throws a StepTimeoutError naming the step when the unit never finishes", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("x\n")],
			activePolls: Infinity,
		});
		const err = await runStep(g.io, {
			name: "30-slow",
			script: SCRIPT,
			log: () => {},
			pollMs: 1,
			timeoutMs: 30,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepTimeoutError);
		expect(err.step).toBe("30-slow");
		expect(err.message).toContain("30-slow");
	});

	it("retries transient guest agent errors while polling", async () => {
		let showN = 0;
		let readN = 0;
		const g = fakeGuest({
			chunks: [Buffer.from("hi\n")],
			rc: "0",
			onExec: (cmd) => {
				if (cmd[0] === "systemctl" && cmd[1] === "show" && showN++ < 2)
					throw new QgaTimeoutError(
						500,
						"VM 1 qga command 'guest-exec-status' failed - got timeout",
						"guest-exec-status",
					);
			},
			onRead: () => {
				if (readN++ === 0)
					throw new PveApiError(500, "QEMU guest agent is not running");
			},
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(r.exitStatus).toBe(0);
		expect(stepText(out)).toBe("hi\n");
		expect(out.some((c) => c.startsWith("[umiak-tpl] transient error"))).toBe(
			true,
		);
	});

	it("retries client-side timeouts and 502/504 while polling and logs each message once", async () => {
		const errs = [
			new Error("GET /nodes/pve/qemu/1/agent/exec-status: timeout"),
			new Error("GET /nodes/pve/qemu/1/agent/exec-status: timeout"),
			new PveApiError(502, "GET /nodes/pve/qemu/1/agent/exec: Bad Gateway"),
			new PveApiError(
				504,
				"POST /nodes/pve/qemu/1/agent/exec: Gateway Timeout",
			),
		];
		const g = fakeGuest({
			chunks: [Buffer.from("hi\n")],
			rc: "0",
			onExec: (cmd) => {
				if (cmd[0] === "systemctl" && cmd[1] === "show") {
					const e = errs.shift();
					if (e) throw e;
				}
			},
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(r.exitStatus).toBe(0);
		// The step log itself is unchanged; notes about retried errors come on their own lines.
		expect(r.tail).toEqual(["hi"]);
		const notes = out.filter((c) => c.startsWith("[umiak-tpl]"));
		expect(notes).toEqual([
			"[umiak-tpl] transient error, retrying: GET /nodes/pve/qemu/1/agent/exec-status: timeout\n",
			"[umiak-tpl] transient error, retrying: GET /nodes/pve/qemu/1/agent/exec: Bad Gateway\n",
			"[umiak-tpl] transient error, retrying: POST /nodes/pve/qemu/1/agent/exec: Gateway Timeout\n",
		]);
	});

	it("does not treat a client-side timeout of the systemd-run start as transient", async () => {
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "systemd-run")
					throw new Error("POST /nodes/pve/qemu/1/agent/exec: timeout");
			},
		});
		await expect(
			runStep(g.io, { name: "s", script: SCRIPT, log: () => {}, ...fast }),
		).rejects.toThrow("agent/exec: timeout");
		// No unit check either: the start error went straight up.
		expect(
			g.calls.filter((c) => c.cmd[0] === "systemctl" && c.cmd[1] === "show"),
		).toHaveLength(0);
	});

	it("does not swallow non-transient errors while polling", async () => {
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "systemctl" && cmd[1] === "show")
					throw new PveApiError(403, "Permission check failed");
			},
		});
		await expect(
			runStep(g.io, {
				name: "s",
				script: SCRIPT,
				log: () => {},
				...fast,
			}),
		).rejects.toThrow("Permission check failed");
	});

	it("after an ambiguous start error checks the unit and does not start it again", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("hi\n")],
			rc: "0",
			startError: new QgaTimeoutError(
				500,
				"VM 1 qga command 'guest-exec-status' failed - got timeout",
				"guest-exec-status",
			),
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(r.exitStatus).toBe(0);
		expect(out.join("")).toBe("hi\n");
		expect(g.calls.filter((c) => c.cmd[0] === "systemd-run")).toHaveLength(1);
		expect(
			g.calls.some((c) => c.cmd.join(" ").includes("-p LoadState,ActiveState")),
		).toBe(true);
	});

	it("fails with the original error when the unit provably did not start", async () => {
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "systemd-run")
					throw new QgaTimeoutError(
						500,
						"VM 1 qga command 'guest-exec' failed - got timeout",
						"guest-exec",
					);
			},
		});
		await expect(
			runStep(g.io, { name: "s", script: SCRIPT, log: () => {}, ...fast }),
		).rejects.toThrow(/step s.*did not start.*guest-exec/s);
		expect(g.calls.filter((c) => c.cmd[0] === "systemd-run")).toHaveLength(1);
	});

	it("fails when systemd-run exits non-zero", async () => {
		const g = fakeGuest({
			onExec: (cmd) =>
				cmd[0] === "systemd-run"
					? { exitCode: 1, stdout: "", stderr: "Unit already exists" }
					: undefined,
		});
		await expect(
			runStep(g.io, { name: "s", script: SCRIPT, log: () => {}, ...fast }),
		).rejects.toThrow(/Unit already exists/);
	});

	it("rejects step names that are not [a-z0-9-]+", async () => {
		const g = fakeGuest();
		for (const name of ["", "A", "a b", "a;rm", "../x", "a_b"])
			await expect(
				runStep(g.io, { name, script: SCRIPT, log: () => {}, ...fast }),
			).rejects.toThrow(/invalid step name/);
		expect(g.calls).toHaveLength(0);
	});
});

describe("runStep robustness", () => {
	it("delivers log bytes that appear only after the unit was seen inactive", async () => {
		const reads: number[] = [];
		const parts = [Buffer.from("a\n"), Buffer.from("b\n"), Buffer.alloc(0)];
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd[0] === "systemctl")
					return ok("LoadState=not-found\nActiveState=inactive\n");
				return ok();
			},
			async readFile(path, offset) {
				if (path.endsWith(".rc")) return Buffer.from("0\n");
				reads.push(offset);
				return parts[Math.min(reads.length - 1, parts.length - 1)] as Buffer;
			},
			async ping() {
				return true;
			},
		};
		const out: string[] = [];
		const r = await runStep(io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(out.join("")).toBe("a\nb\n");
		expect(r.tail).toEqual(["a", "b"]);
		expect(reads).toEqual([0, 2, 4]);
	});

	it("uses the rc file of a unit that was already collected", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("done\n")],
			rc: "0\n",
			collected: true,
		});
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
		});
		expect(r).toEqual({ exitStatus: 0, tail: ["done"] });
	});

	it("accepts a collected unit after an ambiguous start error when the rc file exists", async () => {
		const g = fakeGuest({
			chunks: [Buffer.from("done\n")],
			rc: "5\n",
			collected: true,
			startError: new QgaTimeoutError(
				500,
				"VM 1 qga command 'guest-exec' failed - got timeout",
				"guest-exec",
			),
		});
		const err = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepFailedError);
		expect(err.exitStatus).toBe(5);
		expect(g.calls.filter((c) => c.cmd[0] === "systemd-run")).toHaveLength(1);
	});

	it("re-checks a not-yet-visible unit after an ambiguous start error", async () => {
		let checks = 0;
		const g = fakeGuest({
			chunks: [Buffer.from("hi\n")],
			rc: "0",
			startError: netError("socket hang up", "ECONNRESET"),
			hideFiles: () => checks < 4,
			onExec: (cmd) => {
				if (cmd.join(" ").includes("LoadState,ActiveState"))
					return checks++ < 3
						? ok("LoadState=not-found\nActiveState=inactive\n")
						: ok("LoadState=loaded\nActiveState=active\n");
			},
		});
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
			// The window must outlast the four scripted checks however slow the
			// machine is; it ends at the fourth (the unit is seen loaded).
			startCheckMs: 60_000,
		});
		expect(r.exitStatus).toBe(0);
		expect(checks).toBe(4);
		expect(g.calls.filter((c) => c.cmd[0] === "systemd-run")).toHaveLength(1);
	});

	it("does not call the unit not started when the last check got no answer", async () => {
		const g = fakeGuest({
			startError: netError(),
			onExec: (cmd) => {
				if (cmd.join(" ").includes("LoadState,ActiveState")) throw netError();
			},
		});
		await expect(
			runStep(g.io, { name: "s", script: SCRIPT, log: () => {}, ...fast }),
		).rejects.toThrow(/cannot tell whether the unit started.*ECONNRESET/);
	});

	it.each([
		["ECONNRESET", "read ECONNRESET"],
		["EPIPE", "write EPIPE"],
		["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:8006"],
		[undefined, "socket hang up"],
	])("retries a connection error (%s) while polling", async (code, msg) => {
		let showN = 0;
		let readN = 0;
		let prepN = 0;
		const g = fakeGuest({
			chunks: [Buffer.from("hi\n")],
			rc: "0",
			onExec: (cmd) => {
				if (cmd[0] === "bash" && prepN++ === 0) throw netError(msg, code);
				if (cmd[0] === "systemctl" && cmd[1] === "show" && showN++ < 2)
					throw netError(msg, code);
			},
			onRead: () => {
				if (readN++ === 0) throw netError(msg, code);
			},
		});
		const out: string[] = [];
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: (c) => out.push(c),
			...fast,
		});
		expect(r.exitStatus).toBe(0);
		expect(stepText(out)).toBe("hi\n");
		expect(out.some((c) => c.startsWith("[umiak-tpl] transient error"))).toBe(
			true,
		);
		expect(prepN).toBeGreaterThan(1);
		expect(g.calls.filter((c) => c.cmd[0] === "systemd-run")).toHaveLength(1);
	});

	it("does not retry unrelated errors as network errors", async () => {
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "systemctl" && cmd[1] === "show")
					throw new TypeError("x is not a function");
			},
		});
		await expect(
			runStep(g.io, { name: "s", script: SCRIPT, log: () => {}, ...fast }),
		).rejects.toThrow(TypeError);
	});

	it("includes the last transient error in the timeout error", async () => {
		const cause = netError("read ECONNRESET");
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "systemctl" && cmd[1] === "show") throw cause;
			},
		});
		const err = await runStep(g.io, {
			name: "30-slow",
			script: SCRIPT,
			log: () => {},
			pollMs: 1,
			timeoutMs: 30,
		}).catch((e) => e);
		expect(err).toBeInstanceOf(StepTimeoutError);
		expect(err.message).toContain("30-slow");
		expect(err.message).toContain("last error: read ECONNRESET");
		expect(err.cause).toBe(cause);
	});

	it("retries the prepare exec until the step timeout and reports the last error", async () => {
		const g = fakeGuest({
			onExec: (cmd) => {
				if (cmd[0] === "bash") throw netError();
			},
		});
		await expect(
			runStep(g.io, {
				name: "s",
				script: SCRIPT,
				log: () => {},
				pollMs: 1,
				timeoutMs: 20,
			}),
		).rejects.toThrow(/ECONNRESET/);
		expect(g.calls.some((c) => c.cmd[0] === "systemd-run")).toBe(false);
	});

	it("keeps only the last 200 lines of a huge chunk", async () => {
		const lines = 300_000;
		const g = fakeGuest({
			chunks: [Buffer.from(`${"x\n".repeat(lines - 1)}last\n`)],
			rc: "0",
		});
		const r = await runStep(g.io, {
			name: "s",
			script: SCRIPT,
			log: () => {},
			...fast,
		});
		expect(r.tail).toHaveLength(200);
		expect(r.tail.at(-1)).toBe("last");
	});
});

describe("mountSeed", () => {
	it("mounts the cidata ISO read-only unless already mounted", async () => {
		const g = fakeGuest();
		await mountSeed(g.io);
		expect(g.calls[0]?.cmd).toEqual([
			"bash",
			"-c",
			"mkdir -p /mnt/seed && (mountpoint -q /mnt/seed || mount -o ro LABEL=cidata /mnt/seed)",
		]);
	});

	it("throws with stderr when mounting fails", async () => {
		const g = fakeGuest({
			onExec: () => ({ exitCode: 32, stdout: "", stderr: "no such device" }),
		});
		await expect(mountSeed(g.io)).rejects.toThrow(/no such device/);
	});
});

describe("rebootGuest", () => {
	function rebootGuestFake(opts: { bootIds: string[]; pings?: boolean[] }) {
		const calls: string[][] = [];
		let rebooted = false;
		let idN = 0;
		let pingN = 0;
		const io: GuestIo = {
			async exec(cmd) {
				calls.push(cmd);
				if (cmd[0] === "cat") {
					const id = opts.bootIds[Math.min(idN++, opts.bootIds.length - 1)];
					return ok(`${id}\n`);
				}
				if (cmd[0] === "systemctl" && cmd[1] === "reboot") {
					rebooted = true;
					throw new Error("agent went away");
				}
				return ok();
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				if (!rebooted) return true;
				return opts.pings?.[pingN++] ?? true;
			},
		};
		return { io, calls };
	}

	it("waits for a different boot id, then remounts the seed", async () => {
		const g = rebootGuestFake({
			bootIds: ["boot-a", "boot-a", "boot-a", "boot-b"],
			pings: [false, true, true, true],
		});
		await rebootGuest(g.io, { timeoutMs: 5_000, pollMs: 1 });
		const names = g.calls.map((c) => c.join(" "));
		expect(names[0]).toBe("cat /proc/sys/kernel/random/boot_id");
		expect(names[1]).toBe("systemctl reboot");
		expect(g.calls.filter((c) => c[0] === "cat")).toHaveLength(4);
		expect(names.at(-1)).toContain("mount -o ro LABEL=cidata /mnt/seed");
	});

	it("times out when the boot id never changes", async () => {
		const g = rebootGuestFake({ bootIds: ["boot-a"] });
		await expect(
			rebootGuest(g.io, { timeoutMs: 30, pollMs: 1 }),
		).rejects.toThrow(/reboot/);
		expect(g.calls.some((c) => c.includes("LABEL=cidata"))).toBe(false);
	});

	it("reports the last error in the reboot timeout", async () => {
		let rebooted = false;
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd[0] === "cat" && !rebooted) return ok("boot-a\n");
				if (cmd[0] === "systemctl") {
					rebooted = true;
					throw netError();
				}
				throw netError("read ECONNRESET");
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await expect(rebootGuest(io, { timeoutMs: 30, pollMs: 1 })).rejects.toThrow(
			/last state: read ECONNRESET/,
		);
	});

	it("fails fast when systemctl reboot reports an error exit code", async () => {
		const io: GuestIo = {
			async exec(cmd) {
				if (cmd[0] === "cat") return ok("boot-a\n");
				return { exitCode: 1, stdout: "", stderr: "Access denied" };
			},
			async readFile() {
				return Buffer.alloc(0);
			},
			async ping() {
				return true;
			},
		};
		await expect(
			rebootGuest(io, { timeoutMs: 5_000, pollMs: 1 }),
		).rejects.toThrow(/Access denied/);
	});
});

describe("pveGuestIo", () => {
	function fakeApi(
		onGet: (path: string, params: unknown) => unknown,
	): PveClient & { gets: { path: string; params: unknown }[] } {
		const gets: { path: string; params: unknown }[] = [];
		return {
			gets,
			async get(path: string, params?: unknown) {
				gets.push({ path, params });
				return onGet(path, params) as never;
			},
			async post() {
				throw new PveApiError(500, "unreachable");
			},
			async put() {
				throw new Error("unused");
			},
			async delete() {
				throw new Error("unused");
			},
			async waitTask() {},
		};
	}

	it("reads file-read with decode=0 and decodes base64", async () => {
		const api = fakeApi(() => ({
			content: Buffer.from("héllo").toString("base64"),
			"bytes-read": Buffer.byteLength("héllo"),
		}));
		const io = pveGuestIo(api, "pve", 501);
		const buf = await io.readFile("/var/log/x.log", 10, 100);
		expect(buf.toString()).toBe("héllo");
		expect(api.gets[0]).toEqual({
			path: "/nodes/pve/qemu/501/agent/file-read",
			params: { file: "/var/log/x.log", offset: 10, count: 100, decode: false },
		});
	});

	it("tolerates a missing bytes-read and truncates to it when present", async () => {
		const b64 = Buffer.from("abcdef").toString("base64");
		let r: unknown = { content: b64 };
		const io = pveGuestIo(
			fakeApi(() => r),
			"pve",
			501,
		);
		expect((await io.readFile("/f", 0, 10)).toString()).toBe("abcdef");
		r = { content: b64, "bytes-read": 4, truncated: true };
		expect((await io.readFile("/f", 0, 4)).toString()).toBe("abcd");
		r = {};
		expect((await io.readFile("/f", 0, 4)).length).toBe(0);
	});

	it("treats a missing file as empty and propagates other errors", async () => {
		let msg = "Failed to open file '/f': No such file or directory";
		const io = pveGuestIo(
			fakeApi(() => {
				throw new PveApiError(500, msg);
			}),
			"pve",
			501,
		);
		expect((await io.readFile("/f", 0, 4)).length).toBe(0);
		msg = "QEMU guest agent is not running";
		await expect(io.readFile("/f", 0, 4)).rejects.toThrow(/not running/);
	});

	it("ping reports false when the agent does not answer", async () => {
		const io = pveGuestIo(
			fakeApi(() => ({})),
			"pve",
			501,
		);
		expect(await io.ping()).toBe(false);
	});
});
