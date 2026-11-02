import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInvocation, TemplateBuildJobs } from "./setup-build.mjs";

const state = {
	steps: {
		connection: {
			data: {
				node: "pve",
				apiUrl: "https://pve:8006",
				tokenId: "umiak@pve!dev",
				tlsName: "pve",
				sshHost: "192.168.1.2",
			},
		},
		limits: { data: { vmidMin: 500, vmidMax: 589, storage: "local-lvm" } },
		network: { data: { tunnelUrl: "wss://192.168.1.3/v1/connect" } },
	},
};
test("build invocation binds exact recipe slot, existing credentials and isolated registry", () => {
	const invocation = buildInvocation(
		"linux",
		state,
		"/secrets",
		"https://stack:8443",
		"/assets",
	);
	assert.equal(invocation.env.UMIAK_TEMPLATE_VMID_RANGE, "597-597");
	assert.equal(invocation.env.UMIAK_VMID_RANGE, "500-589");
	assert.equal(
		invocation.env.UMIAK_PVE_TOKEN_SECRET_FILE,
		"/secrets/pve-token",
	);
	assert.ok(invocation.args.includes("--tunnel-url"));
	assert.ok(invocation.args.includes("--agent-package"));
	assert.throws(() =>
		buildInvocation(
			"linux; reboot",
			state,
			"/secrets",
			"https://stack",
			"/assets",
		),
	);
});
test("jobs persist failure and never report interrupted work as complete", async () => {
	let data = structuredClone(state);
	const store = {
		read: async () => structuredClone(data),
		write: async (x) => {
			data = structuredClone(x);
		},
	};
	const jobs = new TemplateBuildJobs({
		store,
		run: async () => {
			throw new Error("builder failed");
		},
		getState: () => data,
	});
	await jobs.start("linux");
	await jobs.settled();
	assert.equal(data.buildJob.status, "error");
	assert.match(data.buildJob.error, /builder failed/);
	data.buildJob = { status: "running", slug: "linux" };
	await jobs.init();
	assert.equal(data.buildJob.status, "error");
	assert.match(data.buildJob.error, /interrupted/);
});
