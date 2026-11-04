import assert from "node:assert/strict";
import test from "node:test";
import {
	allocateTemplateVmid,
	templateRange,
	validateTemplateInventory,
	validateTemplateRange,
} from "./setup-vmids.mjs";
import { testNodes } from "./test-nodes.mjs";

const limits = {
	vmidMin: 500,
	vmidMax: 589,
	templateVmidMin: 700,
	templateVmidMax: 704,
};
test("template range is separate and adoption infers existing slots without relocating builds", () => {
	assert.throws(
		() => validateTemplateRange({ ...limits, templateVmidMin: 580 }),
		/overlap/,
	);
	assert.deepEqual(
		validateTemplateRange({
			...limits,
			templateVmidMin: 9000,
			templateVmidMax: 9001,
		}),
		{ templateVmidMin: 9000, templateVmidMax: 9001 },
	);
	const state = {
		steps: {
			templates: {
				data: { builds: [595, 596, 597, 598].map((pveVmid) => ({ pveVmid })) },
			},
		},
	};
	assert.deepEqual(templateRange(state), {
		templateVmidMin: 595,
		templateVmidMax: 598,
	});
	assert.deepEqual(
		state.steps.templates.data.builds.map((x) => x.pveVmid),
		[595, 596, 597, 598],
	);
	assert.deepEqual(templateRange({ steps: {} }), {
		templateVmidMin: 600,
		templateVmidMax: 699,
	});
});
test("allocation checks cluster inventory, skips occupied IDs on other nodes and nextid outside configured range", async () => {
	const paths = [];
	const pve = {
		get: async (path) => {
			paths.push(path);
			return path === "/cluster/nextid"
				? "100"
				: [
						{ vmid: 700, type: "qemu" },
						{ vmid: 701, type: "lxc" },
						{ vmid: 703, node: "other" },
					];
		},
	};
	assert.equal(await allocateTemplateVmid(pve, limits), 702);
	assert.deepEqual(paths, ["/cluster/resources", "/cluster/nextid"]);
});
test("allocation fails closed when every configured ID is occupied", async () => {
	const pve = {
		get: async (path) =>
			path === "/cluster/nextid"
				? 700
				: [700, 701, 702, 703, 704].map((vmid) => ({ vmid })),
	};
	await assert.rejects(
		allocateTemplateVmid(pve, limits),
		/No free template VMID/,
	);
});
test("range inventory reports conflicts without selecting or changing any existing VM", () => {
	const inventory = validateTemplateInventory(limits, [
		{ vmid: 700 },
		{ vmid: 702 },
		{ vmid: 500 },
	]);
	assert.deepEqual(inventory, {
		occupiedTemplateVmids: [700, 702],
		freeTemplateVmids: 3,
	});
});

test("adoption registers existing VMIDs unchanged even after configuring a new build range", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const builds = [595, 596, 597].map((pveVmid, i) => ({
		pveVmid,
		templateSlug: ["windows-desktop", "linux-desktop", "linux"][i],
	}));
	let retired = false;
	let headless = false;
	let state = {
		steps: {
			connection: { status: "ready", data: { node: "pve" } },
			host: { status: "ready" },
			limits: { status: "ready", data: limits },
			network: { status: "ready" },
		},
	};
	const reads = [];
	const handler = createSetupHandler({
		nodes: testNodes,
		store: {
			read: async () => structuredClone(state),
			write: async (value) => {
				state = value;
			},
		},
		pool: {
			query: async (sql, args) => {
				assert.match(sql, /^SELECT id,version/);
				return {
					rows: [
						{
							id: args[2],
							version: "20261101.1",
							status: retired ? "retired" : headless ? "deprecated" : "active",
							headless,
						},
					],
				};
			},
		},
		makePve: () => ({
			get: async (path) => {
				reads.push(path);
				return { template: 1, tags: "umiak-tpl;umiak-desktop" };
			},
		}),
	});
	await handler.wizard.run("templates", { builds });
	assert.deepEqual(
		state.steps.templates.data.builds.map((x) => x.pveVmid),
		[595, 596, 597],
	);
	assert.equal(state.steps.templates.data.builds[0].templateSlug, "windows");
	headless = true;
	await assert.rejects(handler.wizard.run("templates", { builds }), /headless/);
	headless = false;
	retired = true;
	await assert.rejects(handler.wizard.run("templates", { builds }), /retired/);
	assert.deepEqual(
		reads.slice(0, builds.length),
		builds.map((x) => `/nodes/pve/qemu/${x.pveVmid}/config`),
	);
});

test("rebuild dry-run allocates a fresh free slot without starting a VM or changing state", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const state = {
		steps: {
			connection: { status: "ready", data: { node: "pve" } },
			host: { status: "ready" },
			limits: { status: "ready", data: limits },
			network: { status: "ready", data: {} },
			templates: {
				status: "ready",
				data: { builds: [{ templateSlug: "linux", pveVmid: 597 }] },
			},
		},
	};
	const writes = [];
	const handler = createSetupHandler({
		nodes: testNodes,
		store: {
			read: async () => structuredClone(state),
			write: async (value) => writes.push(value),
		},
		pool: {},
		makePve: () => ({
			get: async (path) =>
				path === "/cluster/resources"
					? [{ vmid: 700 }, { vmid: 597 }]
					: path === "/cluster/nextid"
						? 701
						: [],
		}),
	});
	await assert.rejects(
		handler.jobs.start("linux", { dryRun: true }),
		/confirm/,
	);
	assert.deepEqual(
		await handler.jobs.start("linux", {
			dryRun: true,
			confirmRebuild: "linux",
		}),
		{ status: "dry-run", slug: "linux", templateVmid: 701 },
	);
	assert.deepEqual(writes, []);
});

test("detected templates omit a deprecated custom headless Windows build", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const state = {
		steps: {
			connection: { status: "ready", data: { node: "pve" } },
			limits: { status: "ready", data: { ...limits, nodeId: "node" } },
		},
	};
	const handler = createSetupHandler({
		nodes: testNodes,
		store: { read: async () => structuredClone(state) },
		pool: {
			query: async (_sql, args) => ({
				rows:
					args[1] === 600
						? [{ id: "headless", status: "deprecated", headless: true }]
						: [{ id: "desktop", status: "active", headless: false }],
			}),
		},
		makePve: () => ({
			get: async (path) =>
				path.endsWith("/qemu")
					? [
							{
								vmid: 600,
								template: 1,
								tags: "umiak-tpl",
								name: "OLD_HEADLESS",
							},
							{
								vmid: 601,
								template: 1,
								tags: "umiak-tpl",
								name: "NEW_DESKTOP",
							},
						]
					: {
							template: 1,
							tags: "umiak-tpl;umiak-template-windows;umiak-desktop",
						},
		}),
	});
	let html = "";
	await handler(
		{ method: "GET", url: "/setup" },
		{
			writeHead: () => {},
			end: (value) => {
				html = value;
			},
		},
		{ owner: true, origin: "http://localhost" },
	);
	assert.doesNotMatch(html, /OLD_HEADLESS/);
	assert.match(html, /NEW_DESKTOP/);
});
