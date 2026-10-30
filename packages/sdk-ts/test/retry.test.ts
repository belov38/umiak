import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_ERROR, SbxError, UNEXPECTED_RESPONSE } from "../src/errors.ts";
import { backoffMs, withRetry } from "../src/retry.ts";

function apiError(
	status: number,
	retryable: boolean,
	extra: { code?: string; retryAfterMs?: number } = {},
): SbxError {
	return new SbxError({
		status,
		code: extra.code ?? "out_of_capacity",
		message: "test",
		retryable,
		details: {},
		requestId: "req_1",
		retryAfterMs: extra.retryAfterMs ?? null,
	});
}

function rawError(status: number): SbxError {
	return new SbxError({
		status,
		code: UNEXPECTED_RESPONSE,
		message: `HTTP ${status}`,
		retryable: false,
		details: {},
		requestId: null,
	});
}

/** A function that throws the given errors in turn, then returns "ok". */
function script(...errors: unknown[]) {
	const calls: number[] = [];
	const fn = async () => {
		calls.push(Date.now());
		const next = errors.shift();
		if (next !== undefined) throw next;
		return "ok";
	};
	return { fn, calls };
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("which failures are retried", () => {
	const cases: Array<{
		name: string;
		method: string;
		idempotent: boolean;
		error: unknown;
		retried: boolean;
	}> = [
		{
			name: "GET network error",
			method: "GET",
			idempotent: false,
			error: new TypeError("fetch failed"),
			retried: true,
		},
		{
			name: "DELETE network error",
			method: "DELETE",
			idempotent: false,
			error: new TypeError("fetch failed"),
			retried: true,
		},
		{
			name: "POST network error without a key",
			method: "POST",
			idempotent: false,
			error: new TypeError("fetch failed"),
			retried: false,
		},
		{
			name: "POST network error with a key",
			method: "POST",
			idempotent: true,
			error: new TypeError("fetch failed"),
			retried: true,
		},
		{
			name: "PATCH network error without a key",
			method: "PATCH",
			idempotent: false,
			error: new TypeError("fetch failed"),
			retried: false,
		},
		...[502, 503, 504, 429].map((status) => ({
			name: `GET ${status} without an envelope`,
			method: "GET",
			idempotent: false,
			error: rawError(status),
			retried: true,
		})),
		{
			name: "GET 500 without an envelope",
			method: "GET",
			idempotent: false,
			error: rawError(500),
			retried: false,
		},
		{
			name: "POST 503 without an envelope and without a key",
			method: "POST",
			idempotent: false,
			error: rawError(503),
			retried: false,
		},
		{
			name: "POST 503 without an envelope with a key",
			method: "POST",
			idempotent: true,
			error: rawError(503),
			retried: true,
		},
		{
			name: "POST 503 retryable:true without a key",
			method: "POST",
			idempotent: false,
			error: apiError(503, true),
			retried: true,
		},
		{
			name: "POST 503 retryable:false without a key",
			method: "POST",
			idempotent: false,
			error: apiError(503, false),
			retried: false,
		},
		{
			name: "POST 503 retryable:false with a key",
			method: "POST",
			idempotent: true,
			error: apiError(503, false),
			retried: false,
		},
		{
			name: "GET 502 retryable:false (agent_error)",
			method: "GET",
			idempotent: false,
			error: apiError(502, false, { code: "agent_error" }),
			retried: false,
		},
		{
			name: "GET 404",
			method: "GET",
			idempotent: false,
			error: apiError(404, false, { code: "not_found" }),
			retried: false,
		},
		{
			name: "POST 409 operation_in_progress retryable:true",
			method: "POST",
			idempotent: false,
			error: apiError(409, true, { code: "operation_in_progress" }),
			retried: true,
		},
		{
			name: "network_error SbxError marked retryable",
			method: "POST",
			idempotent: true,
			error: new SbxError({
				status: 0,
				code: NETWORK_ERROR,
				message: "x",
				retryable: true,
				details: {},
				requestId: null,
			}),
			retried: true,
		},
	];

	for (const c of cases) {
		it(`${c.name}: ${c.retried ? "retried" : "not retried"}`, async () => {
			const { fn, calls } = script(c.error);
			const p = withRetry(fn, {
				method: c.method,
				idempotent: c.idempotent,
				random: () => 0,
			});
			p.catch(() => {});
			await vi.runAllTimersAsync();
			if (c.retried) {
				await expect(p).resolves.toBe("ok");
				expect(calls).toHaveLength(2);
			} else {
				await expect(p).rejects.toBe(c.error);
				expect(calls).toHaveLength(1);
			}
		});
	}
});

describe("backoff", () => {
	it("is 0.5 s doubling up to 8 s, full jitter", () => {
		const caps = [0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, () => 1));
		expect(caps).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
		expect(backoffMs(3, () => 0.25)).toBe(1000);
		expect(backoffMs(3, () => 0)).toBe(0);
	});

	it("waits the jittered delay between attempts", async () => {
		const { fn, calls } = script(rawError(503), rawError(503), rawError(503));
		const p = withRetry(fn, { method: "GET", random: () => 1 });
		await vi.runAllTimersAsync();
		await expect(p).resolves.toBe("ok");
		const gaps = calls.slice(1).map((t, i) => t - (calls[i] as number));
		expect(gaps).toEqual([500, 1000, 2000]);
	});

	it("Retry-After wins over the backoff", async () => {
		const { fn, calls } = script(apiError(503, true, { retryAfterMs: 2000 }));
		const p = withRetry(fn, { method: "GET", random: () => 1 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(calls).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(p).resolves.toBe("ok");
		expect(calls).toHaveLength(2);
		expect((calls[1] as number) - (calls[0] as number)).toBe(2000);
	});
});

describe("budget", () => {
	it("gives up with the last error when the next wait would pass the budget", async () => {
		const first = rawError(503);
		const second = rawError(504);
		const { fn, calls } = script(first, second, rawError(503));
		const p = withRetry(fn, { method: "GET", budgetMs: 1000, random: () => 1 });
		p.catch(() => {});
		await vi.runAllTimersAsync();
		// 500 ms wait fits; the next 1000 ms wait would end at 1500 ms > 1000 ms.
		await expect(p).rejects.toBe(second);
		expect(calls).toHaveLength(2);
	});

	it("Retry-After longer than the budget ends at once", async () => {
		const err = apiError(429, true, {
			code: "rate_limited",
			retryAfterMs: 5000,
		});
		const { fn, calls } = script(err);
		await expect(withRetry(fn, { method: "GET", budgetMs: 1000 })).rejects.toBe(
			err,
		);
		expect(calls).toHaveLength(1);
	});

	it("defaults to 60 s", async () => {
		const errors = Array.from({ length: 50 }, () => rawError(503));
		const { fn, calls } = script(...errors);
		const p = withRetry(fn, { method: "GET", random: () => 1 });
		p.catch(() => {});
		await vi.runAllTimersAsync();
		await expect(p).rejects.toBeInstanceOf(SbxError);
		// Waits 0.5 + 1 + 2 + 4 + 6 × 8 = 55.5 s before the 11th attempt; one more
		// 8 s wait would end at 63.5 s > 60 s.
		expect(calls).toHaveLength(11);
		expect((calls.at(-1) as number) - (calls[0] as number)).toBeLessThanOrEqual(
			60_000,
		);
	});

	it("budget 0 never retries", async () => {
		const err = rawError(503);
		const { fn, calls } = script(err);
		await expect(withRetry(fn, { method: "GET", budgetMs: 0 })).rejects.toBe(
			err,
		);
		expect(calls).toHaveLength(1);
	});
});

describe("signal", () => {
	it("abort during the backoff rejects with AbortError at once", async () => {
		const ac = new AbortController();
		const { fn, calls } = script(rawError(503));
		const p = withRetry(fn, {
			method: "GET",
			signal: ac.signal,
			random: () => 1,
		});
		p.catch(() => {});
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toHaveLength(1);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		await vi.runAllTimersAsync();
		expect(calls).toHaveLength(1);
	});

	it("an already aborted signal makes no attempt", async () => {
		const { fn, calls } = script();
		await expect(
			withRetry(fn, { method: "GET", signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toHaveLength(0);
	});

	it("an abort error from the attempt is not retried", async () => {
		const ac = new AbortController();
		const fn = vi.fn(async () => {
			ac.abort();
			throw ac.signal.reason;
		});
		await expect(
			withRetry(fn, { method: "GET", signal: ac.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("the abort reason is kept (timeout)", async () => {
		const ac = new AbortController();
		const { fn } = script(rawError(503));
		const p = withRetry(fn, {
			method: "GET",
			signal: ac.signal,
			random: () => 1,
		});
		p.catch(() => {});
		await vi.advanceTimersByTimeAsync(10);
		ac.abort(new DOMException("deadline", "TimeoutError"));
		await expect(p).rejects.toMatchObject({ name: "TimeoutError" });
	});
});
