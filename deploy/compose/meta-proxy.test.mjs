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
			(await fetch(base + "/v1/meta", { method: "POST" })).status,
			404,
		);
		assert.equal(calls, 0);
		assert.deepEqual(
			await (
				await fetch(base + "/v1/meta", {
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
