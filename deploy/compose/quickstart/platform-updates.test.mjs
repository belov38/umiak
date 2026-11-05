import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { MemoryOwnerRepository, OwnerStore } from "./owner.mjs";
import { validateUpdateSettings } from "./platform-updates.mjs";
import { createQuickstartServer } from "./server.mjs";

test("update settings allow only bounded declarative policy", () => {
	assert.equal(validateUpdateSettings({}).channel, "stable");
	assert.equal(validateUpdateSettings({}).auto, false);
	for (const data of [
		{ channel: "beta" },
		{ start: "25:00" },
		{ auto: "true" },
		{ paused: 1 },
		{ start: "03:00", end: "03:00" },
		{ command: "reboot" },
	])
		assert.throws(() => validateUpdateSettings(data));
	assert.equal(
		validateUpdateSettings({ channel: "edge", start: "23:00", end: "02:00" })
			.channel,
		"edge",
	);
});

test("updates require an owner browser and same origin; invalid policy never writes", async () => {
	const store = new OwnerStore(new MemoryOwnerRepository());
	const code = await store.init();
	let writes = 0;
	const updates = {
		read: async () => ({
			settings: validateUpdateSettings({}),
			status: {},
			history: [],
		}),
		write: async () => {
			writes++;
		},
	};
	const server = createQuickstartServer({
		store,
		updates,
		env: { UMIAK_RUNNING_VERSION: "dev-123456" },
		transport: http,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (path, data, headers = {}) =>
		fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(data),
		});
	try {
		assert.equal(
			(
				await fetch(`${base}/owner/updates`, {
					headers: { accept: "application/json" },
				})
			).status,
			401,
		);
		const claim = await post("/owner/claim", { code }, { origin: base });
		const cookie = claim.headers.get("set-cookie").split(";")[0];
		const response = await fetch(`${base}/owner/updates`, {
			headers: { cookie },
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).runningVersion, "dev-123456");
		assert.equal(
			(
				await post(
					"/owner/updates",
					{ channel: "edge" },
					{ cookie, origin: "https://evil" },
				)
			).status,
			403,
		);
		assert.equal(
			(
				await post(
					"/owner/updates",
					{ channel: "beta" },
					{ cookie, origin: base },
				)
			).status,
			400,
		);
		assert.equal(writes, 0);
		assert.equal(
			(
				await post(
					"/owner/updates",
					{ channel: "edge" },
					{ cookie, origin: base },
				)
			).status,
			200,
		);
		assert.equal(writes, 1);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("policy and recipe channel commit together and roll back together", async () => {
	const { PgPlatformUpdates } = await import("./platform-updates.mjs");
	const calls = [];
	const client = {
		query: async (sql, values) => {
			calls.push({ sql, values });
		},
		release: () => {},
	};
	const updates = new PgPlatformUpdates({ connect: async () => client });
	await updates.write({ channel: "edge" });
	assert.equal(calls[0].sql, "BEGIN");
	assert.match(calls[1].sql, /advisory_xact_lock/);
	assert.match(calls[2].sql, /quickstart.setup/);
	assert.equal(JSON.parse(calls[2].values[0]).channel, "edge");
	assert.match(calls[3].sql, /quickstart.updates/);
	assert.equal(calls.at(-1).sql, "COMMIT");
	calls.length = 0;
	client.query = async (sql) => {
		calls.push({ sql });
		if (sql.includes("INSERT")) throw Error("disk full");
	};
	await assert.rejects(updates.write({ channel: "stable" }), /disk full/);
	assert.equal(calls.at(-1).sql, "ROLLBACK");
});
