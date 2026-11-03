import assert from "node:assert/strict";
import test from "node:test";
import { createMetaProxy } from "./meta-proxy.mjs";

test("metadata bridge forwards only anonymous metadata and never arbitrary API paths", async () => {
	let calls = 0;
	const server = createMetaProxy(async () => {
		calls++;
		return Response.json({ tenancy: "single" });
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		for (const path of ["/v1/me", "/v1/meta?x=1", "/v1/meta/../me"])
			assert.equal((await fetch(base + path)).status, 404);
		assert.equal(
			(await fetch(`${base}/v1/meta`, { method: "POST" })).status,
			404,
		);
		assert.equal(calls, 0);
		assert.deepEqual(
			await (
				await fetch(`${base}/v1/meta`, {
					headers: { authorization: "Bearer ignored" },
				})
			).json(),
			{ tenancy: "single" },
		);
		assert.equal(calls, 1);
	} finally {
		await new Promise((r) => server.close(r));
	}
});

test("metadata bridge uses configured canonical API authority instead of internal DNS Host", async (t) => {
	const fetchServer = globalThis.fetch;
	t.mock.method(globalThis, "fetch", async (url, options) => {
		assert.equal(url, "http://api:8080/v1/meta");
		return new Headers(options.headers).get("host") === "localhost:4180"
			? Response.json({ authMode: "none" })
			: new Response("local_host_forbidden", { status: 403 });
	});
	const server = createMetaProxy(undefined, {
		UMIAK_API_URL: "http://localhost:4180",
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const response = await fetchServer(
		`http://127.0.0.1:${server.address().port}/v1/meta`,
		{ headers: { host: "evil.example" } },
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { authMode: "none" });
});
