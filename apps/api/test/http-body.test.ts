// Listener-wide body handling: a body that breaks while the body-limit
// middleware reads it is 400 validation (not 500); HEAD answers cancel the
// GET handler's streamed body.
import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { ApiEnv } from "../src/deps.ts";
import { bodyLimits } from "../src/http/body-limit.ts";
import { onErrorHandler } from "../src/http/errors.ts";
import { requestId } from "../src/http/request-id.ts";
import { TEST_API_KEY } from "../src/testing/index.ts";
import { createHarness } from "./helpers/harness.ts";

const harness = () => createHarness({ bearer: TEST_API_KEY });

describe("body limit", () => {
	it("a body that breaks mid-read is 400 validation", async () => {
		const h = harness();
		let reached = false;
		h.app.post("/v1/__test/body", async (c) => {
			reached = true;
			await c.req.text();
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
		// Not buffered ahead: the handler reads the body itself.
		expect(reached).toBe(true);
	});

	it("a chunked body is not read before authentication", async () => {
		const h = harness();
		let pulls = 0;
		const endless = new ReadableStream<Uint8Array>({
			pull(ctl) {
				pulls++;
				ctl.enqueue(new Uint8Array(64 * 1024));
			},
		});
		const res = await h.app.request(
			new Request("http://api.test/v1/sandboxes", {
				method: "POST",
				body: endless,
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(401);
		// At most what the stream queues up front; nothing near the limit.
		expect(pulls).toBeLessThan(5);
	});

	it("a chunked body above the limit is 413 while the handler reads it", async () => {
		const h = harness();
		let read = 0;
		h.app.post("/v1/__test/body", async (c) => {
			const reader = c.req.raw.body?.getReader();
			for (;;) {
				const r = await reader?.read();
				if (r === undefined || r.done) break;
				read += r.value.byteLength;
			}
			return c.body(null, 204);
		});
		let sent = 0;
		const big = new ReadableStream<Uint8Array>({
			pull(ctl) {
				if (sent >= 3 * 1024 * 1024) return ctl.close();
				sent += 256 * 1024;
				ctl.enqueue(new Uint8Array(256 * 1024));
			},
		});
		const res = await h.app.request(
			new Request("http://api.test/v1/__test/body", {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_API_KEY}` },
				body: big,
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("payload_too_large");
		expect(read).toBeLessThanOrEqual(1024 * 1024);
		expect(sent).toBeLessThan(3 * 1024 * 1024);
	});

	it("a bounded body that does not arrive in time is 400 validation", async () => {
		const app = new Hono<ApiEnv>();
		app.use("*", requestId(), bodyLimits({ timeoutMs: 50 }));
		app.onError(onErrorHandler(pino({ level: "silent" })));
		app.post("/v1/x", async (c) => c.text(await c.req.text()));
		const stalled = new ReadableStream<Uint8Array>({
			start(ctl) {
				ctl.enqueue(new Uint8Array(10));
			},
		});
		const res = await app.request(
			new Request("http://api.test/v1/x", {
				method: "POST",
				body: stalled,
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("validation");
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
