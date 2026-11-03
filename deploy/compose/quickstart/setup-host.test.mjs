import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pinnedPve } from "./setup-host.mjs";
import { testTls } from "./test-helpers/tls.mjs";

test("pinned PVE transport supports task log pagination and volume deletion", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-pve-transport-"));
	let server;
	try {
		const tls = await testTls(dir);
		const requests = [];
		server = https.createServer(tls, (req, res) => {
			requests.push([req.method, req.url]);
			res.end(JSON.stringify({ data: [] }));
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const api = pinnedPve(
			{
				apiUrl: `https://127.0.0.1:${server.address().port}`,
				tlsName: "localhost",
				fingerprint: new X509Certificate(tls.cert).fingerprint256,
			},
			"test",
		);
		await api.get("/nodes/pve/tasks/UPID%3Apve/log?start=500&limit=500");
		await api.delete("/nodes/pve/storage/local/content/local%3Aiso%2Fa.iso");
		assert.deepEqual(requests, [
			["GET", "/api2/json/nodes/pve/tasks/UPID%3Apve/log?start=500&limit=500"],
			[
				"DELETE",
				"/api2/json/nodes/pve/storage/local/content/local%3Aiso%2Fa.iso",
			],
		]);
	} finally {
		if (server) await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});
