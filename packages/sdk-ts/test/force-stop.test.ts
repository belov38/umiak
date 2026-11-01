// forceStop of fork and saved snapshot (S9 §24.8): the flag goes into the
// request body; the 409 `snapshot_requires_stop` of a running Windows
// sandbox reaches the caller as SbxError with its message and details.
import { describe, expect, it } from "vitest";
import { Sbx, SbxError } from "../src/index.ts";

const API = "https://api.example.test";

interface Seen {
	method: string;
	url: URL;
	body: string;
}

function fakeFetch(replies: Response[]) {
	const seen: Seen[] = [];
	const fetch = async (input: Request | string | URL, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		seen.push({
			method: req.method,
			url: new URL(req.url),
			body: await req.text(),
		});
		const next = replies.shift();
		if (next === undefined) throw new Error("no scripted reply left");
		return next;
	};
	return { fetch: fetch as typeof globalThis.fetch, seen };
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const MESSAGE =
	"Windows sandboxes are forked from a stopped VM; stop it first or retry with forceStop: true (CLI --force-stop), which stops the sandbox, takes the snapshot and starts it again";
const DETAILS = {
	reason: "windows_running",
	retryWith: { forceStop: true },
	cli: "--force-stop",
};
const requiresStop = () =>
	json(409, {
		error: {
			code: "snapshot_requires_stop",
			message: MESSAGE,
			retryable: false,
			details: DETAILS,
			requestId: "req_1",
		},
	});

function sbx(fetch: typeof globalThis.fetch) {
	return new Sbx({ baseUrl: API, apiKey: "sbx_test", fetch, env: {} });
}

describe("forceStop", () => {
	it("fork sends forceStop in the body", async () => {
		const h = fakeFetch([
			json(202, { sandbox: { id: "sb_2", slug: "copy", state: "creating" } }),
		]);
		const copy = await sbx(h.fetch)
			.sandboxes.handle("sb_1")
			.fork({ forceStop: true });
		expect(copy.id).toBe("sb_2");
		expect(h.seen[0]?.url.pathname).toBe("/v1/sandboxes/sb_1/fork");
		expect(JSON.parse(h.seen[0]?.body ?? "")).toEqual({ forceStop: true });
	});

	it("snapshots.create sends forceStop in the body", async () => {
		const h = fakeFetch([
			json(202, {
				snapshot: { name: "s", state: "creating" },
				operation: { id: "op_1" },
			}),
		]);
		await sbx(h.fetch).snapshots.create({
			sandbox: "sb_1",
			name: "s",
			forceStop: true,
		});
		expect(h.seen[0]?.url.pathname).toBe("/v1/snapshots");
		expect(JSON.parse(h.seen[0]?.body ?? "")).toEqual({
			sandbox: "sb_1",
			name: "s",
			forceStop: true,
		});
	});

	it("409 snapshot_requires_stop is an SbxError with message and details", async () => {
		for (const call of [
			(s: Sbx) => s.sandboxes.handle("sb_1").fork(),
			(s: Sbx) => s.snapshots.create({ sandbox: "sb_1", name: "s" }),
		]) {
			const h = fakeFetch([requiresStop()]);
			const err = await call(sbx(h.fetch)).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SbxError);
			expect(err).toMatchObject({
				status: 409,
				code: "snapshot_requires_stop",
				message: MESSAGE,
				retryable: false,
				details: DETAILS,
			});
			// Not retryable: one request only.
			expect(h.seen).toHaveLength(1);
		}
	});
});
