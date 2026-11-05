import assert from "node:assert/strict";
import test from "node:test";
import { TemplateBuildJobs } from "./setup-build.mjs";
import { cleanupBuild } from "./setup-build-cleanup.mjs";

function memory(initial = { steps: {} }) {
	let state = initial;
	let pending = Promise.resolve();
	return {
		read: async () => structuredClone(state),
		write: async (s) => {
			state = structuredClone(s);
		},
		exclusive: (fn) => {
			const next = pending.then(fn);
			pending = next.catch(() => {});
			return next;
		},
	};
}
test("failed and cancelled builders release clean reservations, retain failed cleanup reasons", async () => {
	for (const blocked of [false, true]) {
		const events = [];
		const store = memory();
		const jobs = new TemplateBuildJobs({
			store,
			run: async () => {
				throw Error("verify failed");
			},
			interrupt: async () => events.push("interrupt"),
			release: async () => {
				events.push("release");
				if (blocked) throw Error("VM 501 remains");
			},
		});
		await jobs.start("linux", { nodeId: "pve" });
		await jobs.settled();
		assert.deepEqual(events, ["interrupt", "release"]);
		assert.match(
			(await store.read()).buildJob.error,
			blocked ? /VM 501 remains/ : /verify failed/,
		);
	}
});
test("server queue is serial, shared across sessions and stops on failure", async () => {
	const store = memory();
	let complete;
	const calls = [];
	const jobs = new TemplateBuildJobs({
		store,
		run: async (_slug, _state, job) => {
			calls.push(job.nodeId);
			if (job.nodeId === "a")
				await new Promise((r) => {
					complete = r;
				});
			else throw Error("failed during verify");
			return {};
		},
	});
	await jobs.startQueue({ nodes: ["a", "b", "c"], names: { b: "pve" } });
	while (!complete) await new Promise(setImmediate);
	const otherBrowser = new TemplateBuildJobs({ store });
	assert.deepEqual((await otherBrowser.store.read()).buildQueue.states, {
		a: "Building",
		b: "Waiting",
		c: "Waiting",
	});
	await assert.rejects(
		otherBrowser.startQueue({ nodes: ["a"] }),
		/already running/,
	);
	complete();
	await jobs.settled();
	assert.deepEqual(calls, ["a", "b"]);
	const q = (await store.read()).buildQueue;
	assert.deepEqual(q.states, { a: "Ready", b: "Failed", c: "Not started" });
	assert.equal(q.message, "Queue stopped: pve failed during verify");
});
test("restart stops persisted queue and interrupts its job without launching another runner", async () => {
	const store = memory({
		steps: {},
		buildQueue: {
			active: true,
			nodes: ["a", "b"],
			states: { a: "Building", b: "Waiting" },
		},
		buildJob: { id: "old", nodeId: "a", status: "running" },
	});
	let interrupted = 0;
	const restarted = new TemplateBuildJobs({
		store,
		interrupt: async () => {
			interrupted++;
		},
		run: async () => {
			throw Error("must not launch");
		},
	});
	await restarted.init();
	assert.equal(interrupted, 1);
	assert.deepEqual((await store.read()).buildQueue.states, {
		a: "Stopped",
		b: "Not started",
	});
	assert.equal((await store.read()).buildQueue.active, false);
	assert.match((await store.read()).buildJob.error, /interrupted by restart/);
});
test("stop queue finishes current build without starting waiting nodes", async () => {
	const store = memory();
	let complete;
	const jobs = new TemplateBuildJobs({
		store,
		run: async () => {
			await new Promise((r) => {
				complete = r;
			});
			return {};
		},
	});
	await jobs.startQueue({ nodes: ["a", "b"] });
	while (!complete) await new Promise(setImmediate);
	await jobs.stopQueue();
	complete();
	await jobs.settled();
	assert.deepEqual((await store.read()).buildQueue.states, {
		a: "Ready",
		b: "Not started",
	});
});
function cleanupFixture({
	vms = [],
	disks = [],
	cfg = { tags: "umiak-tpl", name: "umiak-tpl-test" },
	runner = true,
	tasks = [],
} = {}) {
	const queries = [];
	const mutations = [];
	const client = {
		query: async (sql) => {
			queries.push(sql);
			return {
				rowCount: 1,
				rows: sql.includes("SELECT status")
					? [{ status: "interrupted", template_slug: "linux" }]
					: sql.includes("AS ok")
						? [{ ok: runner }]
						: sql.startsWith("SELECT vmid")
							? [{ vmid: 701 }]
							: [],
			};
		},
	};
	const pve = {
		get: async (path) =>
			path.endsWith("/tasks")
				? tasks
				: path.endsWith("/config")
					? cfg
					: path.endsWith("/status")
						? { status: "stopped", exitstatus: "OK" }
						: vms,
		post: async () => {
			mutations.push("stop");
			return "UPID:stop";
		},
		request: async (method) => {
			assert.equal(method, "DELETE");
			mutations.push("delete");
			vms = [];
			disks = [];
			return "UPID:delete";
		},
	};
	const options = {
		service: { transact: (fn) => fn({ client }) },
		node: { nodeId: "a", name: "pve" },
		request: { jobId: "job" },
		state: { steps: { connection: { data: {} } } },
		limits: {
			vmidMin: 500,
			vmidMax: 589,
			templateVmidMin: 700,
			templateVmidMax: 710,
		},
		api: async () => pve,
		probe: async (_c, _s, req) => {
			if (req.op === "lv.remove") {
				mutations.push("lv.remove");
				disks = [];
			}
			return { lvs: disks };
		},
	};
	return { options, queries, mutations };
}
test("shared cleanup releases only after absence checks; inspection never mutates", async () => {
	const f = cleanupFixture();
	await cleanupBuild({
		...f.options,
		request: { jobId: "job", inspect: true },
	});
	assert.ok(!f.queries.some((q) => q.startsWith("DELETE")));
	await cleanupBuild(f.options);
	assert.ok(
		f.queries.some((q) => q.includes("UPDATE runtime.node_build_jobs")),
	);
	assert.deepEqual(f.mutations, []);
});
test("cleanup requires confirmation and removes only leased tagged resources", async () => {
	const f = cleanupFixture({
		vms: [{ vmid: 701, status: "stopped" }],
		disks: [{ name: "vm-701-disk-0", tags: ["umiak"] }],
	});
	await assert.rejects(cleanupBuild(f.options), /confirm removal/);
	assert.deepEqual(f.mutations, []);
	await cleanupBuild({
		...f.options,
		request: { jobId: "job", confirmRemove: true },
	});
	assert.deepEqual(f.mutations, ["delete"]);
	const disk = cleanupFixture({
		disks: [{ name: "vm-701-disk-0", tags: ["umiak"] }],
	});
	await cleanupBuild({
		...disk.options,
		request: { jobId: "job", confirmRemove: true },
	});
	assert.deepEqual(disk.mutations, ["lv.remove"]);
});
test("cleanup refuses foreign VMs/disks, unknown active VMs, live runners and PVE tasks", async () => {
	for (const input of [
		{ vms: [{ vmid: 701 }], cfg: { name: "foreign", tags: "umiak" } },
		{ disks: [{ name: "vm-701-disk-0", tags: [] }] },
		{ vms: [{ vmid: 501, status: "running" }] },
		{ runner: false },
		{ tasks: [{ user: "umiak@pve!build" }] },
	]) {
		const f = cleanupFixture(input);
		await assert.rejects(
			cleanupBuild({
				...f.options,
				request: { jobId: "job", confirmRemove: true },
			}),
		);
		assert.deepEqual(f.mutations, []);
		assert.ok(!f.queries.some((q) => q.startsWith("DELETE")));
	}
});

test("queue skips nodes made Ready by template replication", async () => {
	const store = memory();
	const calls = [];
	let jobs;
	jobs = new TemplateBuildJobs({
		store,
		run: async (_s, _state, job) => {
			calls.push(job.nodeId);
			return {};
		},
		register: async () =>
			jobs.update((s) => {
				s.buildQueue.states.b = "Ready";
			}),
	});
	await jobs.startQueue({ nodes: ["a", "b"] });
	await jobs.settled();
	assert.deepEqual(calls, ["a"]);
	assert.equal((await store.read()).buildQueue.active, false);
});
test("a new queue clears the previous error before validation completes", async () => {
	const store = memory({
		steps: {},
		buildJob: { status: "error", error: "old failure" },
	});
	let validate;
	const jobs = new TemplateBuildJobs({
		store,
		validate: async () =>
			new Promise((r) => {
				validate = r;
			}),
		run: async () => ({}),
	});
	await jobs.startQueue({ nodes: ["a"] });
	while (!validate) await new Promise(setImmediate);
	assert.equal((await store.read()).buildJob.error, null);
	validate();
	await jobs.settled();
});
test("Sandboxes navigation passes through before setup completes", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const handler = createSetupHandler({
		pool: {},
		store: memory({ steps: {}, complete: false }),
	});
	const handled = await handler(
		{ url: "/app", method: "GET" },
		{
			writeHead: () => {
				throw Error("must not redirect");
			},
		},
		{ owner: true, origin: "https://setup.test" },
	);
	assert.equal(handled, false);
});

test("wizard recovery releases the reservation before retry and supports cleanup without retry", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const { Readable } = await import("node:stream");
	for (const retry of [false, true]) {
		const f = cleanupFixture();
		const store = memory({
			steps: {
				connection: { data: {} },
				limits: { data: { ...f.options.limits, providerId: "p" } },
			},
		});
		const pve = await f.options.api();
		const wired = createSetupHandler({
			pool: {},
			store,
			nodes: {
				list: async () => [{ ...f.options.node, buildJobId: "job" }],
				transact: f.options.service.transact,
			},
			makePve: () => pve,
			nodeCheck: f.options.probe,
		});
		let retried = false;
		wired.jobs.start = async () => {
			assert.ok(
				f.queries.some((q) => q.includes("UPDATE runtime.node_build_jobs")),
			);
			retried = true;
		};
		const req = Readable.from([
			JSON.stringify({ nodeId: "a", jobId: "job", retry }),
		]);
		req.method = "POST";
		req.url = "/quickstart/setup/build/recover";
		let status;
		await wired(
			req,
			{
				writeHead: (s) => {
					status = s;
				},
				end: () => {},
			},
			{ owner: true, origin: "https://setup.test" },
		);
		assert.equal(status, 200);
		assert.equal(retried, retry);
	}
});
