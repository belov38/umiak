import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { canonicalFetch } from "./canonical-fetch.mjs";

test("native transport preserves canonical Host over a real socket and forwards body", async (t) => {
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				host: req.headers.host,
				body: Buffer.concat(chunks).toString(),
				path: req.url,
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const response = await canonicalFetch(
		`http://127.0.0.1:${server.address().port}/v1/meta`,
		{ method: "POST", headers: { host: "localhost:4180" }, body: "hello" },
	);
	assert.deepEqual(await response.json(), {
		host: "localhost:4180",
		body: "hello",
		path: "/v1/meta",
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		canonicalFetch(`http://127.0.0.1:${server.address().port}`, {
			signal: controller.signal,
		}),
	);
});

test("quickstart default transport preserves canonical Host on the wire", async (t) => {
	const { createQuickstartServer } = await import("./quickstart/server.mjs");
	const { MemoryOwnerRepository, OwnerStore } = await import(
		"./quickstart/owner.mjs"
	);
	let calls = 0;
	const api = http.createServer((req, res) => {
		calls++;
		if (req.headers.host !== "localhost:4180") {
			res.writeHead(403);
			res.end("host_forbidden");
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ tenancy: "single" }));
	});
	await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => api.close(resolve)));
	const store = new OwnerStore(new MemoryOwnerRepository());
	await store.init();
	const quickstart = createQuickstartServer({
		store,
		env: {
			UMIAK_APP_ORIGIN: "http://localhost:4180",
			UMIAK_QUICKSTART_API_HOST: "127.0.0.1",
			UMIAK_QUICKSTART_API_PORT: String(api.address().port),
		},
	});
	for (const server of [quickstart]) {
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise((resolve) => server.close(resolve)));
		const response = await fetch(
			`http://127.0.0.1:${server.address().port}/v1/meta`,
		);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).tenancy, "single");
	}
	assert.equal(calls, 1);
});
