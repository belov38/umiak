import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((url: string): never => {
	throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({ redirect }));

describe("/ (app root)", () => {
	it("redirects to /app", async () => {
		const { default: RootIndex } = await import("../src/app/(app)/page.tsx");
		expect(() => RootIndex()).toThrow("NEXT_REDIRECT /app");
		expect(redirect).toHaveBeenCalledWith("/app");
	});
});
