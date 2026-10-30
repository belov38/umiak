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
			"exec-status": [new Error("read ECONNRESET")],
		});
		await expect(new Qga(api, "pve").exec(500, ["true"])).rejects.toThrow(
			"ECONNRESET",
		);
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
