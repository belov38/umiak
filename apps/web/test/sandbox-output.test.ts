// Output viewer of the Commands tab and terminal state (S8 §9.6).
import { SbxError } from "@sbx/sdk";
import { describe, expect, it } from "vitest";
import {
	defaultDownloadOffset,
	exitText,
	formatDuration,
	frameText,
	hasLongOutput,
	OUTPUT_DOWNLOAD_LIMIT,
	OUTPUT_TAIL_BYTES,
	outputDownloadUrl,
	tailOffsets,
} from "@/features/sandbox/output";
import {
	closeCodeText,
	ptyFailure,
	ptyTitle,
} from "@/features/sandbox/pty-status";

const stream = (size: number, from = 0, end: number | null = null) => ({
	sizeBytes: size,
	availableFromBytes: from,
	endBytes: end,
});

describe("frame → terminal text", () => {
	it("stdout as is, stderr red in the joint view", () => {
		expect(frameText({ type: "stdout", data: "ok\n" }, "all")).toBe("ok\n");
		expect(frameText({ type: "stderr", data: "bad\n" }, "all")).toBe(
			"\x1b[31mbad\n\x1b[0m",
		);
	});

	it("the filter hides the other stream; stderr alone is not coloured", () => {
		expect(frameText({ type: "stderr", data: "x" }, "stdout")).toBe(null);
		expect(frameText({ type: "stdout", data: "x" }, "stderr")).toBe(null);
		expect(frameText({ type: "stderr", data: "x" }, "stderr")).toBe("x");
		expect(frameText({ type: "pty", data: "x" }, "stdout")).toBe("x");
	});

	it("truncated is a line saying the start was evicted", () => {
		const t = frameText(
			{ type: "truncated", stream: "stdout", availableFrom: 4096 },
			"all",
		);
		expect(t).toContain("evicted");
		expect(t).toContain("4096");
		expect(
			frameText(
				{ type: "truncated", stream: "stdout", availableFrom: 1 },
				"stderr",
			),
		).toBe(null);
	});

	it("exit line by status", () => {
		expect(exitText({ status: "exited", exitCode: 3, signal: null })).toBe(
			"[exited with code 3]",
		);
		expect(
			exitText({ status: "killed", exitCode: null, signal: "SIGTERM" }),
		).toBe("[killed by SIGTERM]");
		expect(
			exitText({
				status: "exited",
				exitCode: 0,
				signal: null,
				outputTruncated: "disk_full",
			}),
		).toContain("disk was full");
		expect(
			frameText(
				{ type: "exit", status: "timed_out", exitCode: null, signal: null },
				"stderr",
			),
		).toContain("[timed out]");
	});
});

describe("offsets and links", () => {
	it("the tail starts OUTPUT_TAIL_BYTES before the end, not before availableFrom", () => {
		expect(
			tailOffsets({
				mode: "detached",
				streams: { stdout: stream(10), stderr: stream(OUTPUT_TAIL_BYTES + 5) },
			}),
		).toEqual({ stdoutOffset: 0, stderrOffset: 5 });
		expect(
			tailOffsets({
				mode: "detached",
				streams: { stdout: stream(100, 90), stderr: stream(0) },
			}),
		).toEqual({ stdoutOffset: 90, stderrOffset: 0 });
		expect(
			tailOffsets({
				mode: "pty",
				streams: { pty: stream(OUTPUT_TAIL_BYTES * 2) },
			}),
		).toEqual({
			stdoutOffset: 0,
			stderrOffset: 0,
			ptyOffset: OUTPUT_TAIL_BYTES,
		});
		expect(tailOffsets({ mode: "detached", streams: null })).toEqual({
			stdoutOffset: 0,
			stderrOffset: 0,
		});
	});

	it("an ended stream counts up to its end", () => {
		expect(
			hasLongOutput({
				streams: { stdout: stream(OUTPUT_TAIL_BYTES + 10, 0, 10) },
			}),
		).toBe(false);
		expect(
			hasLongOutput({ streams: { stdout: stream(OUTPUT_TAIL_BYTES + 1) } }),
		).toBe(true);
	});

	it("download link: stream, offset, 4 MiB limit and the team", () => {
		const url = outputDownloadUrl({
			sandboxId: "sb_1",
			commandId: "cmd_1",
			stream: "stderr",
			offset: 7,
			teamId: "team_1",
		});
		expect(url).toBe(
			"/api/v1/sandboxes/sb_1/commands/cmd_1/output?stream=stderr&offset=7&limit=4194304&team=team_1",
		);
		expect(OUTPUT_DOWNLOAD_LIMIT).toBe(4194304);
	});

	it("the default download is the last 4 MiB still kept", () => {
		const c = { streams: { stdout: stream(OUTPUT_DOWNLOAD_LIMIT + 100, 50) } };
		expect(defaultDownloadOffset(c, "stdout")).toBe(100);
		expect(
			defaultDownloadOffset({ streams: { stdout: stream(10, 0) } }, "stdout"),
		).toBe(0);
		expect(defaultDownloadOffset({ streams: null }, "stderr")).toBe(0);
	});

	it("durations", () => {
		const t0 = "2026-10-31T10:00:00.000Z";
		expect(formatDuration(t0, "2026-10-31T10:00:01.500Z", 0)).toBe("1.5 s");
		expect(formatDuration(t0, "2026-10-31T10:03:04.000Z", 0)).toBe("3 min 4 s");
		expect(formatDuration(null, null, 0)).toBe("—");
	});
});

describe("terminal state", () => {
	const err = (code: string) =>
		new SbxError({ status: 0, code, message: code, retryable: false });

	it("4409 and 4503 explain and offer a retry; 4401 does not", () => {
		expect(ptyFailure(err("sandbox_not_ready"))).toMatchObject({ retry: true });
		expect(ptyFailure(err("sandbox_not_ready")).message).toContain("not ready");
		expect(ptyFailure(err("agent_unavailable"))).toMatchObject({ retry: true });
		expect(ptyFailure(err("unauthorized"))).toMatchObject({ retry: false });
		expect(ptyFailure(err("not_found"))).toMatchObject({ retry: false });
	});

	it("close codes for the reconnecting bar", () => {
		expect(closeCodeText(4503)).toContain("agent");
		expect(closeCodeText(1012)).toContain("restarting");
		expect(closeCodeText(1000)).toBe(null);
	});

	it("tab titles", () => {
		expect(ptyTitle({ command: null, id: "cmd_01abcd" })).toBe("shell abcd");
		expect(ptyTitle({ command: "htop", id: "cmd_1" })).toBe("htop");
	});
});

describe("PTY socket watch", () => {
	it("finds the command of a PTY connect URL", async () => {
		const { ptyCommandOf } = await import("@/lib/ws");
		expect(
			ptyCommandOf(
				"wss://app.test/api/v1/sandboxes/sb_1/ptys/cmd_9/connect?tailBytes=65536&team=team_1",
			),
		).toBe("cmd_9");
		expect(ptyCommandOf("wss://app.test/api/v1/sandboxes/sb_1/commands")).toBe(
			null,
		);
	});
});
