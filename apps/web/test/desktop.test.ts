import { describe, expect, it, vi } from "vitest";
import { fetchDesktopLink } from "../src/features/sandbox/desktop-link";

describe("desktop link lifecycle", () => {
	it("retries starting sessions after two seconds and propagates cancellation", async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const link = vi
			.fn()
			.mockRejectedValueOnce({ code: "desktop_not_ready" })
			.mockResolvedValue({ url: "https://desktop.example" });
		const pending = fetchDesktopLink(link, abort.signal);
		await vi.advanceTimersByTimeAsync(1999);
		expect(link).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual({ url: "https://desktop.example" });
		expect(link).toHaveBeenLastCalledWith({}, { signal: abort.signal });
		vi.useRealTimers();
	});
	it("does not retry permission errors", async () => {
		const error = { code: "forbidden" };
		const link = vi.fn().mockRejectedValue(error);
		await expect(
			fetchDesktopLink(link, new AbortController().signal),
		).rejects.toBe(error);
		expect(link).toHaveBeenCalledTimes(1);
	});
	it("aborts an outstanding retry on tab unmount", async () => {
		const abort = new AbortController();
		const link = vi.fn().mockRejectedValue({ code: "desktop_not_ready" });
		const pending = fetchDesktopLink(link, abort.signal);
		const assertion = expect(pending).rejects.toMatchObject({
			name: "AbortError",
		});
		await Promise.resolve();
		abort.abort();
		await assertion;
		expect(link).toHaveBeenCalledTimes(1);
	});
});
