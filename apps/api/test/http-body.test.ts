// Listener-wide body handling: a body that breaks while the body-limit
// middleware reads it is 400 validation (not 500); HEAD answers cancel the
// GET handler's streamed body.
import { describe, expect, it } from "vitest";
import { TEST_API_KEY } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

const harness = () => createHarness({ bearer: TEST_API_KEY });

describe("body limit", () => {
	it("a body that breaks mid-read is 400 validation", async () => {
		const h = harness();
		let reached = false;
		h.app.post("/v1/__test/body", async (c) => {
			reached = true;
			return c.body(null, 204);
		});
		let sent = false;
		const broken = new ReadableStream<Uint8Array>({
			pull(ctl) {
				if (sent) ctl.error(new Error("connection reset"));
				else {
					sent = true;
					ctl.enqueue(new Uint8Array(100));
				}
			},
		});
		const res = await h.app.request(
			new Request("http://api.test/v1/__test/body", {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_API_KEY}` },
				body: broken,
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; details: { issues: { path: string }[] } };
		};
		expect(body.error.code).toBe("validation");
		expect(body.error.details.issues[0]?.path).toBe("body");
		expect(reached).toBe(false);
	});

	it("a body without Content-Length is read and handed on", async () => {
		const h = harness();
		h.app.post("/v1/__test/body", async (c) => c.text(await c.req.text()));
		const res = await h.app.request(
			new Request("http://api.test/v1/__test/body", {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_API_KEY}` },
				body: new ReadableStream<Uint8Array>({
					start(ctl) {
						ctl.enqueue(new TextEncoder().encode("hello "));
						ctl.enqueue(new TextEncoder().encode("world"));
						ctl.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello world");
	});
});

describe("HEAD", () => {
	it("cancels the streamed body of the GET handler", async () => {
		const h = harness();
		let cancelled = false;
		let pulls = 0;
		h.app.get("/v1/__test/stream", (c) =>
			c.body(
				new ReadableStream<Uint8Array>(
					{
						pull(ctl) {
							pulls++;
							ctl.enqueue(new Uint8Array(10));
						},
						cancel() {
							cancelled = true;
						},
					},
					{ highWaterMark: 0 },
				),
				200,
				{ "X-Kept": "yes" },
			),
		);
		const res = await h.app.request("/v1/__test/stream", {
			method: "HEAD",
			headers: { authorization: `Bearer ${TEST_API_KEY}` },
		});
		expect(res.status).toBe(200);
		expect(res.body).toBeNull();
		expect(res.headers.get("x-kept")).toBe("yes");
		expect(res.headers.get("request-id")).toMatch(/^req_/);
		expect(cancelled).toBe(true);
		expect(pulls).toBe(0);
	});
});
