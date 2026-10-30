// Long-poll waits with a scripted fetch and fake timers: the transport
// retries of one poll fit in the time left of the wait.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientCore } from "../src/client.ts";
import { Sandbox, type SandboxData, waitForOperation } from "../src/sandbox.ts";

const API = "https://api.example.test";

function unavailable() {
	return new Response(
		JSON.stringify({
			error: {
				code: "agent_unavailable",
				message: "try later",
				retryable: true,
				details: {},
				requestId: "req_1",
			},
		}),
		{ status: 503, headers: { "Content-Type": "application/json" } },
	);
}

function core() {
	let calls = 0;
	const c = createClientCore({
		baseUrl: API,
		apiKey: "sbx_test",
		env: {},
		fetch: (async () => {
			calls += 1;
			return unavailable();
		}) as typeof fetch,
	});
	return { core: c, calls: () => calls };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("long-poll waits", () => {
	it("waitUntilReady({timeoutMs: 1000}) does not retry one poll past the deadline", async () => {
		const { core: c, calls } = core();
		const sb = new Sandbox(c, {
			id: "sb_1",
			slug: "quiet-otter-lamp",
			state: "creating",
		} as SandboxData);
		const started = Date.now();
		const p = sb.waitUntilReady({ timeoutMs: 1000 }).catch((e: unknown) => e);
		await vi.runAllTimersAsync();
		expect(await p).toMatchObject({ code: "agent_unavailable" });
		expect(Date.now() - started).toBeLessThanOrEqual(1000);
		expect(calls()).toBeGreaterThanOrEqual(1);
	});

	it("waitForOperation({timeoutMs: 1000}) the same", async () => {
		const { core: c } = core();
		const started = Date.now();
		const p = waitForOperation(c, "op_1", { timeoutMs: 1000 }).catch(
			(e: unknown) => e,
		);
		await vi.runAllTimersAsync();
		expect(await p).toMatchObject({ code: "agent_unavailable" });
		expect(Date.now() - started).toBeLessThanOrEqual(1000);
	});
});
