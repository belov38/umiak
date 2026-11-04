import assert from "node:assert/strict";
import test from "node:test";
import { TemplateBuildJobs } from "./setup-build.mjs";
import { scopedNodeState } from "./setup-nodes.mjs";

test("node-scoped build state uses trusted target SSH, disk/media storage and RAM", () => {
	const original = {
		steps: {
			connection: {
				data: { node: "pve", sshHost: "old", apiUrl: "https://pve:8006" },
			},
			limits: {
				data: {
					providerId: "p",
					nodeId: "a",
					storage: "old",
					ramCapMb: 8192,
					vmidMin: 500,
				},
			},
		},
	};
	const selected = scopedNodeState(original, {
		nodeId: "b",
		providerId: "p",
		name: "pve2",
		sshHost: "192.0.2.2",
		storage: "thin2",
		storageId: "s2",
		mediaStorage: "media2",
		ramCapMb: 4096,
	});
	assert.equal(selected.steps.connection.data.node, "pve2");
	assert.equal(selected.steps.connection.data.sshHost, "192.0.2.2");
	assert.equal(selected.steps.limits.data.storage, "thin2");
	assert.equal(selected.steps.limits.data.nodeId, "b");
	assert.equal(selected.mediaStorage, "media2");
	assert.equal(selected.steps.limits.data.ramCapMb, 4096);
	assert.equal(original.steps.connection.data.node, "pve");
});
test("build reservation precedes host work and failure retains an interrupted reservation", async () => {
	let state = { steps: {} };
	const events = [];
	const store = {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = s;
		},
	};
	const jobs = new TemplateBuildJobs({
		store,
		reserve: async (job) => events.push(["reserve", job.nodeId]),
		interrupt: async () => events.push(["interrupt"]),
		run: async () => {
			events.push(["host"]);
			throw Error("broken");
		},
	});
	await jobs.start("linux", { nodeId: "b" });
	await jobs.settled();
	assert.deepEqual(events, [["reserve", "b"], ["host"], ["interrupt"]]);
	assert.equal(state.buildJob.status, "error");
	assert.equal(state.buildJob.nodeId, "b");
});
test("successful build releases reservation only after registration and cleanup proof", async () => {
	let state = { steps: {} };
	const events = [];
	const jobs = new TemplateBuildJobs({
		store: {
			read: async () => structuredClone(state),
			write: async (s) => {
				state = s;
			},
		},
		reserve: async () => events.push("reserve"),
		run: async () => ({ node: "pve2" }),
		register: async () => events.push("register"),
		finish: async () => events.push("verified-cleanup"),
	});
	await jobs.start("linux", { nodeId: "b" });
	await jobs.settled();
	assert.deepEqual(events, ["reserve", "register", "verified-cleanup"]);
	assert.equal(state.buildJob.status, "ready");
});

test("selected smoke forwards the owner Origin required by the proxied API", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const { testNodes } = await import("./test-nodes.mjs");
	let deleted = false;
	const calls = [];
	const handler = createSetupHandler({
		pool: {},
		nodes: testNodes,
		store: { read: async () => ({}) },
		makePve: () => ({ get: async () => [] }),
		fetcher: async (url, init) => {
			calls.push([url, init]);
			const path = new URL(url).pathname;
			if (path === "/v1/setup/smoke") {
				assert.equal(init.headers.Origin, "https://umiak.ts.net");
				return Response.json({ sandbox: { id: "sb_test" } });
			}
			if (path.endsWith("/commands"))
				return Response.json({
					command: { exitCode: 0 },
					stdout: "umiak-quickstart-ok",
				});
			if (init.method === "DELETE") {
				deleted = true;
				return Response.json({});
			}
			return Response.json({ state: deleted ? "deleted" : "ready" });
		},
	});
	await handler.wizard.steps.smoke(
		{ nodeId: "target" },
		{
			steps: {
				connection: { data: { node: "pve2" } },
				limits: { data: { nodeId: "target", ramCapMb: 4096 } },
			},
		},
		{ origin: "https://umiak.ts.net" },
	);
	assert.equal(calls[0][0], "http://api:8081/v1/setup/smoke");
});

test("trusted bootstrap preserves retired-node facts without checking its old sandbox storage", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const calls = [];
	const handler = createSetupHandler({
		pool: { query: async () => ({ rows: [{ id: "provider" }] }) },
		nodes: {
			installerNodeRetired: async () => true,
			register: async () => ({ nodeId: "retired", storageId: "historic" }),
		},
		makePve: () => ({
			get: async (path) => {
				calls.push(path);
				if (path === "/cluster/resources") return [];
				throw Error("original sandbox storage gone");
			},
		}),
	});
	const state = {
		steps: {
			connection: {
				data: {
					node: "pve",
					apiUrl: "https://pve:8006",
					tlsName: "pve",
					sshHost: "192.0.2.1",
				},
			},
			limits: { data: { nodeId: "retired" } },
		},
	};
	const limits = {
		storage: "old-lvm",
		vmidMin: 500,
		vmidMax: 589,
		templateVmidMin: 600,
		templateVmidMax: 699,
		ramCapMb: 4096,
	};
	const result = await handler.wizard.steps.limits(limits, state, {
		bootstrap: true,
	});
	assert.equal(result.nodeId, "retired");
	assert.deepEqual(calls, ["/cluster/resources"]);
	await assert.rejects(
		handler.wizard.steps.limits(limits, state, {}),
		/storage gone/,
	);
});
