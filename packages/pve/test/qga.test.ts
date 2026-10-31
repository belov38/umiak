import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type Params,
	PveApiError,
	type PveClient,
	QgaTimeoutError,
} from "../src/pve-api.ts";
import { Qga, QgaExecStatusLostError } from "../src/qga.ts";

type Reply = unknown | Error;

/** Answers agent calls from per-command queues; the last reply of a queue repeats. */
class ScriptedPve implements PveClient {
	calls: string[] = [];
	readonly #replies: Record<string, Reply[]>;
	constructor(replies: Record<string, Reply[]>) {
		this.#replies = replies;
	}
	async #reply(method: string, path: string): Promise<never> {
		const cmd = path.split("/agent/")[1] ?? "";
		this.calls.push(`${method} ${cmd}`);
		const q = this.#replies[cmd] ?? [];
		const r = q.length > 1 ? q.shift() : q[0];
		if (r instanceof Error) throw r;
		return r as never;
	}
	get<T>(path: string, _p?: Params): Promise<T> {
		return this.#reply("GET", path);
	}
	post<T>(path: string, _p?: Params): Promise<T> {
		return this.#reply("POST", path);
	}
	put<T>(path: string, _p?: Params): Promise<T> {
		return this.#reply("PUT", path);
	}
	delete<T>(path: string, _p?: Params): Promise<T> {
		return this.#reply("DELETE", path);
	}
	async waitTask(): Promise<void> {}
}

const qgaTimeout = (cmd: string) =>
	new QgaTimeoutError(
		500,
		`GET /nodes/pve/qemu/500/agent/${cmd}: VM 500 qga command 'guest-${cmd}' failed - got timeout`,
		`guest-${cmd}`,
	);
const pidGone = new PveApiError(
	500,
	"GET /nodes/pve/qemu/500/agent/exec-status: Agent error: PID 42 does not exist",
);
const running = { exited: 0 };
const done = { exited: 1, exitcode: 3, "out-data": "out", "err-data": "err" };

describe("Qga.exec", () => {
	it("keeps polling after an exec-status timeout and returns the result", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [running, qgaTimeout("exec-status"), done],
		});
		const r = await new Qga(api, "pve").exec(500, ["true"]);
		expect(r).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
		expect(api.calls).toEqual([
			"POST exec",
			"GET exec-status",
			"GET exec-status",
			"GET exec-status",
		]);
	});

	it("reports a lost exit status when the PID vanished after a timeout", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [qgaTimeout("exec-status"), pidGone],
		});
		const err = await new Qga(api, "pve")
			.exec(500, ["true"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QgaExecStatusLostError);
		expect((err as QgaExecStatusLostError).pid).toBe(42);
		expect(api.calls.filter((c) => c === "POST exec")).toHaveLength(1);
	});

	it("keeps polling after a client-side timeout of exec-status", async () => {
		const clientTimeout = new Error(
			"GET /nodes/pve/qemu/500/agent/exec-status: timeout",
		);
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [running, clientTimeout, done],
		});
		const r = await new Qga(api, "pve").exec(500, ["true"]);
		expect(r).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
		expect(api.calls.filter((c) => c === "POST exec")).toHaveLength(1);
	});

	it("reports a lost exit status when the PID vanished after a client-side timeout", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [
				new Error("GET /nodes/pve/qemu/500/agent/exec-status: timeout"),
				pidGone,
			],
		});
		const err = await new Qga(api, "pve")
			.exec(500, ["true"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QgaExecStatusLostError);
	});

	it("still fails on other plain errors while polling", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [new Error("boom")],
		});
		await expect(new Qga(api, "pve").exec(500, ["true"])).rejects.toThrow(
			"boom",
		);
	});

	it("keeps polling after a broken connection of exec-status (flaky uplink)", async () => {
		const conn = (code: string, msg: string) =>
			Object.assign(new Error(msg), { code });
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [
				running,
				conn("ECONNRESET", "socket hang up"),
				conn("ETIMEDOUT", "connect ETIMEDOUT 100.64.10.2:8006"),
				done,
			],
		});
		const r = await new Qga(api, "pve").exec(500, ["true"]);
		expect(r).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
		expect(api.calls.filter((c) => c === "POST exec")).toHaveLength(1);
	});

	it("reports a lost exit status when the PID vanished after a broken connection", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [
				Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
				pidGone,
			],
		});
		const err = await new Qga(api, "pve")
			.exec(500, ["true"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QgaExecStatusLostError);
	});

	it("treats an agent restart during exec-status like a timeout", async () => {
		const notRunning = new PveApiError(
			500,
			"GET /nodes/pve/qemu/500/agent/exec-status: QEMU guest agent is not running",
		);
		const ok = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [notRunning, done],
		});
		await expect(new Qga(ok, "pve").exec(500, ["true"])).resolves.toEqual({
			exitCode: 3,
			stdout: "out",
			stderr: "err",
		});
		const lost = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [notRunning, pidGone],
		});
		await expect(
			new Qga(lost, "pve").exec(500, ["true"]),
		).rejects.toBeInstanceOf(QgaExecStatusLostError);
	});

	it("reports a lost exit status when the agent restarted between two polls", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [running, pidGone],
		});
		const err = await new Qga(api, "pve")
			.exec(500, ["true"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QgaExecStatusLostError);
		expect((err as QgaExecStatusLostError).cause).toBe(pidGone);
	});

	it("reports a lost exit status for the Windows agent's unformatted PID message", async () => {
		const winGone = new PveApiError(
			500,
			"GET /nodes/pve/qemu/598/agent/exec-status: Agent error: PID lld does not exist",
		);
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [running, winGone],
		});
		const err = await new Qga(api, "pve").exec(500, ["true"]).catch((e) => e);
		expect(err).toBeInstanceOf(QgaExecStatusLostError);
	});

	it("never repeats exec after a timeout of the exec call itself", async () => {
		const api = new ScriptedPve({ exec: [qgaTimeout("exec")] });
		const err = await new Qga(api, "pve")
			.exec(500, ["touch", "/x"])
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QgaTimeoutError);
		expect(api.calls).toEqual(["POST exec"]);
	});

	it("gives up at the deadline even when every poll times out", async () => {
		const api = new ScriptedPve({
			exec: [{ pid: 42 }],
			"exec-status": [qgaTimeout("exec-status")],
		});
		await expect(
			new Qga(api, "pve").exec(500, ["sleep", "9"], { timeoutMs: 1 }),
		).rejects.toThrow(/timed out/);
	});
});

describe("Qga.fsfreezeStatus", () => {
	it('parses "frozen" and "thawed"', async () => {
		const api = new ScriptedPve({
			"fsfreeze-status": [{ result: "frozen" }, { result: "thawed" }],
		});
		const qga = new Qga(api, "pve");
		await expect(qga.fsfreezeStatus(500)).resolves.toBe("frozen");
		await expect(qga.fsfreezeStatus(500)).resolves.toBe("thawed");
		expect(api.calls[0]).toBe("POST fsfreeze-status");
	});

	it("rejects an unknown state", async () => {
		const api = new ScriptedPve({ "fsfreeze-status": [{ result: "weird" }] });
		await expect(new Qga(api, "pve").fsfreezeStatus(500)).rejects.toThrow(
			/weird/,
		);
	});
});

describe("Qga.fsfreezeThaw", () => {
	it("a clean thaw is not auto-thawed and does not read the status", async () => {
		const api = new ScriptedPve({ "fsfreeze-thaw": [{ result: 3 }] });
		await expect(new Qga(api, "pve").fsfreezeThaw(500)).resolves.toEqual({
			autoThawed: false,
		});
		expect(api.calls).toEqual(["POST fsfreeze-thaw"]);
	});

	it("a failed thaw of a guest that thawed itself (VSS hold timeout) is auto-thawed", async () => {
		const api = new ScriptedPve({
			"fsfreeze-thaw": [new PveApiError(500, "guest-fsfreeze-thaw failed")],
			"fsfreeze-status": [{ result: "thawed" }],
		});
		await expect(
			new Qga(api, "pve").fsfreezeThaw(500, { selfThaw: true }),
		).resolves.toEqual({ autoThawed: true });
		expect(api.calls).toEqual(["POST fsfreeze-thaw", "POST fsfreeze-status"]);
	});

	it("rethrows the thaw error when the guest is still frozen or the status fails", async () => {
		const thawErr = new PveApiError(500, "guest-fsfreeze-thaw failed");
		const frozen = new ScriptedPve({
			"fsfreeze-thaw": [thawErr],
			"fsfreeze-status": [{ result: "frozen" }],
		});
		await expect(
			new Qga(frozen, "pve").fsfreezeThaw(500, { selfThaw: true }),
		).rejects.toBe(thawErr);
		const noStatus = new ScriptedPve({
			"fsfreeze-thaw": [thawErr],
			"fsfreeze-status": [new PveApiError(500, "agent timeout")],
		});
		await expect(
			new Qga(noStatus, "pve").fsfreezeThaw(500, { selfThaw: true }),
		).rejects.toBe(thawErr);
	});

	it("without selfThaw (Linux) a failed thaw is thrown even if the guest reports thawed", async () => {
		const thawErr = new PveApiError(500, "guest-fsfreeze-thaw failed");
		const api = new ScriptedPve({
			"fsfreeze-thaw": [thawErr],
			"fsfreeze-status": [{ result: "thawed" }],
		});
		await expect(new Qga(api, "pve").fsfreezeThaw(500)).rejects.toBe(thawErr);
		expect(api.calls).toEqual(["POST fsfreeze-thaw"]);
	});
});

describe("Qga.shutdown", () => {
	it("posts agent/shutdown", async () => {
		const api = new ScriptedPve({ shutdown: [null] });
		await new Qga(api, "pve").shutdown(500);
		expect(api.calls).toEqual(["POST shutdown"]);
	});
});

interface ExecCall {
	command: string[];
	input: string | undefined;
}

/** Fake guest: decodes each exec's stdin like the PowerShell script does and keeps the file. */
class FakeWindowsGuest implements PveClient {
	execs: ExecCall[] = [];
	file = Buffer.alloc(0);
	hashOverride: string | undefined;
	failChunk: number | undefined;
	/** Exec index whose status qemu-ga loses (once). */
	lostExec: number | undefined;
	#last = { exited: 1, exitcode: 0, "out-data": "" };
	async get<T>(_path: string, _p?: Params): Promise<T> {
		if (this.lostExec === this.execs.length - 1) {
			this.lostExec = undefined;
			throw new PveApiError(500, "PID lld does not exist");
		}
		return this.#last as T;
	}
	async post<T>(path: string, p?: Params): Promise<T> {
		if (!path.endsWith("/agent/exec")) throw new Error(`unexpected ${path}`);
		const command = (p?.command ?? []) as string[];
		const input = p?.["input-data"] as string | undefined;
		this.execs.push({ command, input });
		const script = command[command.length - 2] ?? "";
		const chunk = Buffer.from(input ?? "", "base64");
		if (this.failChunk === this.execs.length - 1) {
			this.#last = { exited: 1, exitcode: 1, "out-data": "" };
		} else {
			this.file = /FileMode\]::Create/.test(script)
				? chunk
				: Buffer.concat([this.file, chunk]);
			const hash = /SHA256/.test(script)
				? `${this.hashOverride ?? createHash("sha256").update(this.file).digest("hex").toUpperCase()}\r\n`
				: "";
			this.#last = { exited: 1, exitcode: 0, "out-data": hash };
		}
		return { pid: this.execs.length } as T;
	}
	put<T>(): Promise<T> {
		throw new Error("unexpected put");
	}
	delete<T>(): Promise<T> {
		throw new Error("unexpected delete");
	}
	async waitTask(): Promise<void> {}
}

describe("Qga.fileWriteWindows", () => {
	const data = Buffer.from(
		Array.from({ length: 70_000 }, (_, i) => (i * 7) & 0xff),
	);

	it("sends base64 chunks of at most 32 KiB and checks the sha256", async () => {
		const guest = new FakeWindowsGuest();
		await new Qga(guest, "pve").fileWriteWindows(
			500,
			"C:\\Windows\\Temp\\x.bin",
			data,
		);
		expect(guest.execs).toHaveLength(3);
		for (const e of guest.execs) {
			expect(e.command.slice(0, 4)).toEqual([
				"powershell",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
			]);
			expect(e.command.at(-1)).toBe("C:\\Windows\\Temp\\x.bin");
			expect(Buffer.from(e.input ?? "", "base64").length).toBeLessThanOrEqual(
				32 * 1024,
			);
		}
		// Only the first chunk truncates, only the last one reports the hash.
		const scripts = guest.execs.map((e) => e.command.at(-2) ?? "");
		expect(scripts.map((s) => /FileMode\]::Create/.test(s))).toEqual([
			true,
			false,
			false,
		]);
		expect(scripts.map((s) => /SHA256/.test(s))).toEqual([false, false, true]);
		expect(guest.file.equals(data)).toBe(true);
	});

	it("writes an empty file as one chunk", async () => {
		const guest = new FakeWindowsGuest();
		await new Qga(guest, "pve").fileWriteWindows(
			500,
			"C:\\x.txt",
			Buffer.alloc(0),
		);
		expect(guest.execs).toHaveLength(1);
		expect(guest.file.length).toBe(0);
	});

	it("fails when the guest hash differs", async () => {
		const guest = new FakeWindowsGuest();
		guest.hashOverride = "00".repeat(32);
		await expect(
			new Qga(guest, "pve").fileWriteWindows(500, "C:\\x.bin", data),
		).rejects.toThrow(/sha256/);
	});

	it("fails when a chunk exits non-zero", async () => {
		const guest = new FakeWindowsGuest();
		guest.failChunk = 1;
		await expect(
			new Qga(guest, "pve").fileWriteWindows(500, "C:\\x.bin", data),
		).rejects.toThrow(/chunk 2/);
		expect(guest.execs).toHaveLength(2);
	});

	it("writes the whole file again when a chunk's exec status is lost", async () => {
		const guest = new FakeWindowsGuest();
		guest.lostExec = 1;
		await new Qga(guest, "pve").fileWriteWindows(500, "C:\\x.bin", data);
		// Chunks 1-2 of the first attempt, then all three chunks from Create again.
		expect(guest.execs).toHaveLength(5);
		expect(
			/FileMode\]::Create/.test(guest.execs[2]?.command.at(-2) ?? ""),
		).toBe(true);
		expect(guest.file.equals(data)).toBe(true);
	});

	it("rejects paths that would not survive PowerShell command-line parsing", async () => {
		const guest = new FakeWindowsGuest();
		for (const p of [
			"C:\\a b\\x",
			"C:\\x';calc",
			"C:\\$env\\x",
			"C:\\a,b",
			"C:\\a(b)",
			"C:\\a@b",
			"C:\\a%b%",
			"-Path",
			"",
		])
			await expect(
				new Qga(guest, "pve").fileWriteWindows(500, p, data),
			).rejects.toThrow(/path/);
		expect(guest.execs).toHaveLength(0);
	});
});
