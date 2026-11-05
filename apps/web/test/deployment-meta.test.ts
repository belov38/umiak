import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDeploymentMeta } from "../src/lib/deployment-meta.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("server dashboard metadata", () => {
	it("reads explicit single tenancy anonymously from the backend", async () => {
		vi.stubEnv("UMIAK_WEB_META_URL", "http://backend.test/v1/meta");
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ authMode: "owner", tenancy: "single" })),
			);
		vi.stubGlobal("fetch", fetch);
		expect(await getDeploymentMeta()).toEqual({ tenancy: "single" });
		expect(fetch).toHaveBeenCalledWith(
			"http://backend.test/v1/meta",
			expect.objectContaining({ cache: "no-store", redirect: "error" }),
		);
		expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("headers");
	});
	it("defaults old metadata and unavailability to teams", async () => {
		for (const reply of [
			new Response(JSON.stringify({ authMode: "owner" })),
			new Response("down", { status: 503 }),
			new Response("invalid"),
		]) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
			expect(await getDeploymentMeta()).toEqual({ tenancy: "teams" });
		}
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await getDeploymentMeta()).toEqual({ tenancy: "teams" });
	});
});
