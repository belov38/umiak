// What the sandbox page offers (S8 §9.6) and the C3 block (S8 §17.1).
import type { SandboxData } from "@sbx/sdk";
import { describe, expect, it } from "vitest";
import {
	canConfigure,
	canRead,
	canWork,
	formatBytes,
	formatSeconds,
	headerActions,
	modeString,
	portProblem,
	portUrl,
} from "@/features/sandbox/rules";

function sb(p: Partial<SandboxData>): SandboxData {
	return {
		id: "sb_1",
		slug: "quiet-otter-lamp",
		state: "ready",
		blocked: false,
		blockReason: null,
		activeOperation: null,
		ttlSeconds: null,
		deadlineAt: null,
		...p,
	} as SandboxData;
}

describe("header actions", () => {
	it("ready: stop, fork, recover, snapshot, rename, delete; no resume", () => {
		expect(headerActions(sb({}))).toEqual({
			stop: true,
			resume: false,
			fork: true,
			recover: true,
			extend: false,
			saveSnapshot: true,
			rename: true,
			delete: true,
		});
	});

	it("extend needs a TTL", () => {
		expect(headerActions(sb({ ttlSeconds: 3600 })).extend).toBe(true);
	});

	it("stopped: resume, fork, snapshot; no stop or recover", () => {
		const a = headerActions(sb({ state: "stopped" }));
		expect(a).toMatchObject({
			stop: false,
			resume: true,
			fork: true,
			recover: false,
			saveSnapshot: true,
		});
	});

	it("error: recover and delete", () => {
		const a = headerActions(sb({ state: "error" }));
		expect(a).toMatchObject({ recover: true, delete: true, fork: false });
	});

	it("blocked: only stop and delete stay", () => {
		const a = headerActions(
			sb({ blocked: true, blockReason: "abuse", ttlSeconds: 60 }),
		);
		expect(a).toEqual({
			stop: true,
			resume: false,
			fork: false,
			recover: false,
			extend: false,
			saveSnapshot: false,
			rename: false,
			delete: true,
		});
		expect(headerActions(sb({ blocked: true, state: "stopped" })).resume).toBe(
			false,
		);
	});

	it("deleting: nothing", () => {
		const a = headerActions(sb({ state: "deleting" }));
		expect(Object.values(a).every((v) => v === false)).toBe(true);
	});
});

describe("tab gates", () => {
	it("work needs ready and not blocked; reading only ready", () => {
		expect(canWork(sb({})).ok).toBe(true);
		const blocked = canWork(sb({ blocked: true }));
		expect(blocked.ok).toBe(false);
		expect(!blocked.ok && blocked.reason).toContain("blocked");
		expect(canWork(sb({ state: "stopped" })).ok).toBe(false);
		expect(canRead(sb({ blocked: true })).ok).toBe(true);
		expect(canRead(sb({ state: "stopped" })).ok).toBe(false);
	});

	it("ports and env: any state but deleting, not blocked", () => {
		expect(canConfigure(sb({ state: "stopped" })).ok).toBe(true);
		expect(canConfigure(sb({ state: "deleting" })).ok).toBe(false);
		expect(canConfigure(sb({ blocked: true })).ok).toBe(false);
	});
});

describe("formatting", () => {
	it("ports", () => {
		expect(portProblem("3000")).toBe(null);
		expect(portProblem("22")).toContain("SSH");
		expect(portProblem("0")).not.toBe(null);
		expect(portProblem("70000")).not.toBe(null);
		expect(portProblem("3e3")).not.toBe(null);
		expect(portUrl("https://a-{port}.x.test", 5173)).toBe(
			"https://a-5173.x.test",
		);
	});

	it("seconds, bytes, modes", () => {
		expect(formatSeconds(null)).toBe("none");
		expect(formatSeconds(900)).toBe("15 min");
		expect(formatSeconds(7200)).toBe("2 h");
		expect(formatSeconds(90_000)).toBe("1 d 1 h");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1229)).toBe("1.2 KB");
		expect(modeString("dir", 0o755)).toBe("drwxr-xr-x");
		expect(modeString("file", 0o644)).toBe("-rw-r--r--");
	});
});
