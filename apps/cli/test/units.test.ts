// Unit tests of the argument parsers, the exit code of exec/run and the
// backpressure of raw output (no api).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExitEvent } from "@sbx/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseDuration,
	parseEnvFile,
	parsePairs,
	splitDashDash,
} from "../src/args.ts";
import { commandExitCode, exitCodeOf } from "../src/exit-codes.ts";
import { Output, outputMode } from "../src/output.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sbx-units-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exit = (o: Partial<ExitEvent>): ExitEvent => ({
	type: "exit",
	status: "exited",
	exitCode: 0,
	signal: null,
	reason: "none",
	stdoutOffset: 0,
	stderrOffset: 0,
	...o,
});

describe("commandExitCode (guest semantics, the same on every client OS)", () => {
	it("passes the code of an exited command through", () => {
		expect(commandExitCode(exit({ exitCode: 0 }))).toBe(0);
		expect(commandExitCode(exit({ exitCode: 7 }))).toBe(7);
	});

	it("a killed command is 128 + the Linux signal number", () => {
		const killed = (signal: string | null, exitCode: number | null = null) =>
			commandExitCode(exit({ status: "killed", signal, exitCode }));
		expect(killed("SIGTERM")).toBe(143);
		expect(killed("SIGKILL")).toBe(137);
		// macOS has SIGUSR1 = 30; the guest is Linux: 10.
		expect(killed("SIGUSR1")).toBe(138);
		expect(killed("SIGUSR2")).toBe(140);
		expect(killed("TERM")).toBe(143);
		// An unknown name: the agent's code if it is a signal code, else 137.
		expect(killed("SIGWEIRD", 200)).toBe(200);
		expect(killed("SIGWEIRD")).toBe(137);
		expect(killed(null)).toBe(137);
	});

	it("timed_out is 124; lost and failed_to_start are 125", () => {
		expect(commandExitCode(exit({ status: "timed_out", exitCode: null }))).toBe(
			124,
		);
		expect(commandExitCode(exit({ status: "lost", exitCode: null }))).toBe(125);
		expect(
			commandExitCode(exit({ status: "failed_to_start", exitCode: 127 })),
		).toBe(125);
	});
});

describe("args", () => {
	it("parseDuration: seconds and units; anything else is a usage error", () => {
		expect(parseDuration("90", "--ttl")).toBe(90);
		expect(parseDuration("90s", "--ttl")).toBe(90);
		expect(parseDuration("15m", "--ttl")).toBe(900);
		expect(parseDuration("2h", "--ttl")).toBe(7200);
		expect(parseDuration("7d", "--ttl")).toBe(604_800);
		for (const bad of ["0", "-5", "1.5h", "2w", "", "h"]) {
			let err: unknown;
			try {
				parseDuration(bad, "--ttl");
			} catch (e) {
				err = e;
			}
			expect(exitCodeOf(err), bad).toBe(2);
		}
	});

	it("parseEnvFile: comments, export, quotes and \\n in double quotes", () => {
		const f = join(dir, "a.env");
		writeFileSync(
			f,
			[
				"# comment",
				"",
				"export A=1",
				"B = two ",
				'C="x y"',
				"D='single \\n kept'",
				'E="line1\\nline2"',
				"F=a=b",
				"G=",
			].join("\n"),
		);
		expect(parseEnvFile(f)).toEqual({
			A: "1",
			B: "two",
			C: "x y",
			D: "single \\n kept",
			E: "line1\nline2",
			F: "a=b",
			G: "",
		});
		writeFileSync(f, "NOEQUALS\n");
		expect(() => parseEnvFile(f)).toThrow(/a\.env:1/);
	});

	it("parsePairs never echoes a malformed value (it may be a secret)", () => {
		expect(parsePairs(["A=1", "B=x=y"], "--env")).toEqual({ A: "1", B: "x=y" });
		for (const bad of ["sk-live-secret-value", "=sk-live-secret-value"]) {
			let msg = "";
			try {
				parsePairs([bad], "--secret");
			} catch (e) {
				msg = (e as Error).message;
			}
			expect(msg).toContain("--secret");
			expect(msg).not.toContain("secret-value");
		}
	});

	it("splitDashDash: the words after the first -- and the positionals before it", () => {
		expect(
			splitDashDash(["exec", "sb", "--", "ls", "-la"], ["sb", "ls", "-la"]),
		).toEqual({ before: ["sb"], after: ["ls", "-la"] });
		expect(
			splitDashDash(["--json", "exec", "--", "a", "--", "b"], ["a", "--", "b"]),
		).toEqual({ before: [], after: ["a", "--", "b"] });
		expect(splitDashDash(["exec", "sb"], ["sb"])).toEqual({
			before: ["sb"],
			after: null,
		});
	});
});

describe("output", () => {
	it("only the --json flag (not SBX_OUTPUT=json) asks raw-data commands for frames", () => {
		expect(outputMode(["exec", "--json"], {}).jsonFlag).toBe(true);
		expect(outputMode(["exec"], { SBX_OUTPUT: "json" }).jsonFlag).toBe(false);
		expect(outputMode(["exec", "--json", "--human"], {}).jsonFlag).toBe(false);
		const w = { write: () => true };
		const env = new Output({
			stdout: w,
			stderr: w,
			isTTY: false,
			...outputMode(["exec"], { SBX_OUTPUT: "json" }),
		});
		expect(env.json).toBe(true);
		expect(env.jsonFlag).toBe(false);
	});

	it("data() waits for drain when the writer is full", async () => {
		const listeners: (() => void)[] = [];
		let writes = 0;
		const stdout = {
			write: () => {
				writes++;
				return false;
			},
			once: (_ev: string, cb: () => void) => {
				listeners.push(cb);
			},
		};
		const out = new Output({ stdout, stderr: stdout, isTTY: false });
		let done = false;
		const p = out.data("x").then(() => {
			done = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(writes).toBe(1);
		expect(done).toBe(false);
		for (const l of listeners) l();
		await p;
		expect(done).toBe(true);
	});
});
