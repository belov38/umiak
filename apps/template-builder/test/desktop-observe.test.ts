import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "../../../packages/sdk-ts/src/index.ts";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), append: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("node:fs/promises", () => ({ appendFile: mocks.append }));

import { verifyDesktopIdleHold } from "../../../infra/dev-cp/desktop-observe.ts";

const sb = { data: { slug: "idle-proof" } } as Sandbox;
function samples(tcp: (ms: number) => number, apiAge?: number) {
	mocks.exec.mockImplementation(() =>
		JSON.stringify({
			state: "ready",
			counters: {
				desktopStreams: 1,
				runningCommands: 0,
				openPtys: 0,
				tcpStreams: tcp(Date.now()),
			},
			api_age: apiAge ?? Math.floor(Date.now() / 1000) + 30,
		}),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	mocks.append.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.resetAllMocks();
});

describe("desktop idle acceptance", () => {
	it("excludes setup drain time from the full hold and uses only read-only observation", async () => {
		samples((ms) => (ms < 30_000 ? 3 : 0));
		let settled = false;
		const run = verifyDesktopIdleHold(sb, 10_000, "proof.ndjson");
		void run.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.advanceTimersByTimeAsync(39_000);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1000);
		await run;
		expect(settled).toBe(true);
		const records = mocks.append.mock.calls.map((c) =>
			JSON.parse(c[1] as string),
		);
		expect(
			records.some((r) => r.phase === "settle" && r.counters.tcpStreams === 3),
		).toBe(true);
		expect(records.find((r) => r.phase === "hold")?.elapsedMs).toBe(0);
		expect(
			mocks.exec.mock.calls.every(
				(c) =>
					/SELECT row_to_json/.test(c[2].input) &&
					!/UPDATE|INSERT|DELETE/.test(c[2].input),
			),
		).toBe(true);
	});

	it("rejects new TCP activity after the proof starts", async () => {
		samples((ms) => (ms >= 10_000 ? 1 : 0));
		const rejected = expect(
			verifyDesktopIdleHold(sb, 20_000, "proof.ndjson"),
		).rejects.toThrow("desktopStreams alone");
		await vi.advanceTimersByTimeAsync(10_000);
		await rejected;
	});

	it("fails a stopped sandbox before counting hold time", async () => {
		mocks.exec.mockReturnValue(
			JSON.stringify({ state: "stopped", counters: null }),
		);
		await expect(
			verifyDesktopIdleHold(sb, 10_000, "proof.ndjson"),
		).rejects.toThrow("desktop stopped");
	});

	it("bounds setup drain rather than waiting forever", async () => {
		samples(() => 1);
		const rejected = expect(
			verifyDesktopIdleHold(sb, 10_000, "proof.ndjson"),
		).rejects.toThrow("baseline did not settle");
		await vi.advanceTimersByTimeAsync(120_000);
		await rejected;
	});

	it("still rejects API keepalive during the hold", async () => {
		samples(() => 0, 0);
		const rejected = expect(
			verifyDesktopIdleHold(sb, 90_000, "proof.ndjson"),
		).rejects.toThrow("refreshed by API activity");
		await vi.advanceTimersByTimeAsync(90_000);
		await rejected;
	});
});
