import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CALL_BUDGET_MS,
	Deadline,
	RESPONSE_MARGIN_MS,
} from "../src/deadline.ts";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("constants", () => {
	it("have the S11 7.5 values", () => {
		expect(CALL_BUDGET_MS).toBe(50_000);
		expect(RESPONSE_MARGIN_MS).toBe(1_500);
	});
});

describe("Deadline", () => {
	it("waitMs(50) at the start leaves the response margin", () => {
		const d = new Deadline(new AbortController().signal);
		expect(d.remainingMs()).toBe(50_000);
		expect(d.waitMs(50)).toBe(48_500);
		d.dispose();
	});

	it("waitMs is the requested time when it fits", () => {
		const d = new Deadline(new AbortController().signal);
		expect(d.waitMs(10)).toBe(10_000);
		vi.advanceTimersByTime(45_000);
		expect(d.waitMs(10)).toBe(3_500);
		d.dispose();
	});

	it("waitMs never goes below zero", () => {
		const d = new Deadline(new AbortController().signal);
		vi.advanceTimersByTime(49_000);
		expect(d.waitMs(5)).toBe(0);
		vi.advanceTimersByTime(10_000);
		expect(d.remainingMs()).toBe(0);
		expect(d.waitMs(5)).toBe(0);
		d.dispose();
	});

	it("expires after the budget and aborts the signal", () => {
		const d = new Deadline(new AbortController().signal);
		expect(d.expired()).toBe(false);
		expect(d.signal.aborted).toBe(false);
		vi.advanceTimersByTime(49_999);
		expect(d.expired()).toBe(false);
		vi.advanceTimersByTime(1);
		expect(d.expired()).toBe(true);
		expect(d.signal.aborted).toBe(true);
		expect(d.cancelled()).toBe(false);
		expect((d.signal.reason as Error).name).toBe("TimeoutError");
		d.dispose();
	});

	it("honours a custom budget", () => {
		const d = new Deadline(new AbortController().signal, 1_000);
		expect(d.remainingMs()).toBe(1_000);
		expect(d.waitMs(5)).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(d.expired()).toBe(true);
		d.dispose();
	});

	it("parent abort cancels the signal and is not an expiry", () => {
		const parent = new AbortController();
		const d = new Deadline(parent.signal);
		expect(d.cancelled()).toBe(false);
		parent.abort(new Error("client went away"));
		expect(d.cancelled()).toBe(true);
		expect(d.signal.aborted).toBe(true);
		expect(d.expired()).toBe(false);
		d.dispose();
	});

	it("an already aborted parent is cancelled at once", () => {
		const parent = new AbortController();
		parent.abort();
		const d = new Deadline(parent.signal);
		expect(d.cancelled()).toBe(true);
		expect(d.signal.aborted).toBe(true);
		expect(d.expired()).toBe(false);
		d.dispose();
	});

	it("dispose clears the timer", () => {
		const d = new Deadline(new AbortController().signal);
		expect(vi.getTimerCount()).toBe(1);
		d.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_000);
		expect(d.signal.aborted).toBe(false);
	});

	it("dispose does not leave a listener that aborts later", () => {
		const parent = new AbortController();
		const d = new Deadline(parent.signal);
		d.dispose();
		parent.abort();
		expect(d.signal.aborted).toBe(false);
	});
});
