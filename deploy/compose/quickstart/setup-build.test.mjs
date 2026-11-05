import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInvocation, TemplateBuildJobs } from "./setup-build.mjs";
import { testNodes } from "./test-nodes.mjs";

const state = {
	mediaStorage: "images",
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
		limits: {
			data: {
				providerId: "provider",
				vmidMin: 500,
				vmidMax: 589,
				storage: "local-lvm",
				templateVmidMin: 700,
				templateVmidMax: 704,
			},
		},
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
		"build",
		{ templateVmid: 702 },
	);
	assert.equal(invocation.env.UMIAK_TEMPLATE_VMID_RANGE, "702-702");
	assert.equal(invocation.env.UMIAK_VMID_RANGE, "500-589");
	assert.equal(invocation.env.UMIAK_TEMPLATE_PROVIDER_ID, "provider");
	assert.equal(invocation.env.UMIAK_TEMPLATE_BUILD_JOB_ID, "build");
	assert.equal(invocation.env.UMIAK_TEMPLATE_VMID, "0");
	assert.equal(invocation.env.UMIAK_PVE_MEDIA_STORAGE, "images");
	assert.equal(
		invocation.env.UMIAK_PVE_TOKEN_SECRET_FILE,
		"/secrets/pve-token",
	);
	assert.equal(
		invocation.env.UMIAK_UPDATE_KEYS_FILE,
		"/secrets/update-signing/update-keys.pub",
	);
	assert.equal(
		invocation.env.UMIAK_UPDATE_SIGNING_KEY,
		"/secrets/update-signing/ed25519.key",
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

test("build progress persists across reload and serial build refusal keeps the active job", async () => {
	let data = structuredClone(state);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const store = {
		read: async () => structuredClone(data),
		write: async (next) => {
			data = structuredClone(next);
		},
	};
	const jobs = new TemplateBuildJobs({
		store,
		run: async (_slug, _state, _job, _input, _context, progress) => {
			await progress("Downloading base image\n");
			await gate;
			return { templateSlug: "linux", version: "20261103.2" };
		},
	});
	const first = await jobs.start("linux");
	await assert.rejects(() => jobs.start("windows"), /already running/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.match((await store.read()).buildJob.log, /Downloading/);
	assert.equal((await store.read()).buildJob.id, first.id);
	release();
	await jobs.settled();
	assert.equal(data.buildJob.status, "ready");
	assert.match(data.buildJob.log, /Downloading/);
});

test("dry run validates rebuild confirmation and never launches or changes durable state", async () => {
	let data = structuredClone(state);
	let launches = 0;
	const jobs = new TemplateBuildJobs({
		store: {
			read: async () => structuredClone(data),
			write: async (next) => {
				data = structuredClone(next);
			},
		},
		validate: async (slug, _state, input) => {
			assert.equal(input.confirmRebuild, slug);
			input.templateVmid = 601;
		},
		run: async () => {
			launches++;
		},
	});
	await assert.rejects(() => jobs.start("linux", { dryRun: true }));
	const result = await jobs.start("linux", {
		dryRun: true,
		confirmRebuild: "linux",
	});
	assert.deepEqual(result, {
		status: "dry-run",
		slug: "linux",
		templateVmid: 601,
	});
	assert.equal(launches, 0);
	assert.deepEqual(data, state);
});

test("completed ISO source provenance remains visible after another template job", async () => {
	const { createSetupHandler } = await import("./setup.mjs");
	const builds = [
		{
			templateSlug: "windows",
			pveVmid: 701,
			mediaVerification: "unverified",
			isoSha256: "a".repeat(64),
		},
	];
	const handler = createSetupHandler({
		nodes: testNodes,
		pool: {},
		store: {
			read: async () => ({
				steps: { templates: { data: { builds } } },
				buildJob: { slug: "linux", status: "ready" },
			}),
		},
	});
	let result;
	const response = {
		writeHead: () => {},
		end: (value) => {
			result = JSON.parse(value);
		},
	};
	await handler(
		{ method: "GET", url: "/quickstart/setup/build", headers: {} },
		response,
		{ owner: true, origin: "https://umiak.example.test" },
	);
	assert.equal(result.buildJob.slug, "linux");
	assert.deepEqual(result.builds, builds);
});

test("ISO verification is retained in a build record after a later build", async () => {
	let data = structuredClone(state);
	const jobs = new TemplateBuildJobs({
		store: {
			read: async () => structuredClone(data),
			write: async (next) => {
				data = structuredClone(next);
			},
		},
		run: async (slug) => ({
			templateSlug: slug,
			mediaVerification: slug === "windows" ? "unverified" : undefined,
			isoSha256: slug === "windows" ? "a".repeat(64) : undefined,
		}),
	});
	const first = await jobs.start("windows");
	await jobs.settled();
	await jobs.start("linux");
	await jobs.settled();
	assert.equal(
		data.buildRecords[first.id].manifest.mediaVerification,
		"unverified",
	);
	assert.equal(data.buildRecords[first.id].manifest.isoSha256, "a".repeat(64));
});

for (const fails of [false, true])
	test(`completed setup survives a ${fails ? "failed" : "successful"} dashboard build`, async () => {
		let data = { ...structuredClone(state), complete: true };
		const jobs = new TemplateBuildJobs({
			store: {
				read: async () => structuredClone(data),
				write: async (x) => {
					data = x;
				},
			},
			run: async () => {
				if (fails) throw Error("failed");
				return { templateSlug: "linux" };
			},
		});
		await jobs.start("linux");
		assert.equal(data.complete, true);
		await jobs.settled();
		assert.equal(data.complete, true);
	});
test("build accepts the documented PVE ISO volume", () => {
	const invocation = buildInvocation(
		"windows",
		state,
		"/secrets",
		"https://stack",
		"/assets",
		"build",
		{
			templateVmid: 702,
			iso: "images:iso/windows.iso",
			isoSha256: "a".repeat(64),
		},
	);
	assert.ok(invocation.args.includes("windows.iso"));
	assert.equal(invocation.env.UMIAK_PVE_MEDIA_STORAGE, "images");
});

test("Windows desktop legacy build alias invokes the canonical recipe", () => {
	const invocation = buildInvocation(
		"windows-desktop",
		state,
		"/secrets",
		"https://stack",
		"/assets",
		"build",
		{
			templateVmid: 702,
			iso: "windows.iso",
			isoSha256: "a".repeat(64),
		},
	);
	assert.equal(invocation.slug, "windows");
	assert.equal(invocation.args[2], "windows");
	assert.ok(!invocation.args.includes("windows-desktop"));
});

test("legacy build alias validates canonical rebuild confirmation before any launch", async () => {
	let validated;
	const jobs = new TemplateBuildJobs({
		store: { read: async () => state },
		validate: async (slug, _state, input) => {
			validated = { slug, confirmRebuild: input.confirmRebuild };
		},
		run: async () => {
			throw new Error("must not launch");
		},
	});
	const result = await jobs.start("windows-desktop", {
		dryRun: true,
		confirmRebuild: "windows-desktop",
	});
	assert.deepEqual(validated, { slug: "windows", confirmRebuild: "windows" });
	assert.equal(result.slug, "windows");
});

test("completion resolves the current job artifact when an old ready manifest reuses its VMID", async () => {
	const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { readBuiltManifest } = await import("./setup-build.mjs");
	const dir = await mkdtemp(join(tmpdir(), "s19-manifests-"));
	const common = {
		node: "pve2",
		templateSlug: "linux",
		pveVmid: 600,
		status: "ready",
		verify: { ok: true },
	};
	try {
		await writeFile(
			join(dir, "a-old.json"),
			JSON.stringify({
				...common,
				nodeBuildJobId: "old-job",
				buildId: "old-build",
				version: "20261104.1",
			}),
		);
		await writeFile(
			join(dir, "b-new.json"),
			JSON.stringify({
				...common,
				nodeBuildJobId: "current-job",
				buildId: "new-build",
				version: "20261104.2",
			}),
		);
		const invocation = {
			slot: 600,
			slug: "linux",
			env: {
				UMIAK_PVE_NODE: "pve2",
				UMIAK_TEMPLATE_BUILD_JOB_ID: "current-job",
				UMIAK_TEMPLATE_REGISTRY: dir,
			},
		};
		assert.equal((await readBuiltManifest(invocation)).buildId, "new-build");
		invocation.env.UMIAK_TEMPLATE_BUILD_JOB_ID = "absent-job";
		await assert.rejects(
			readBuiltManifest(invocation),
			/verified ready manifest/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("full build log path accepts only job ids", () => {
	const jobs = new TemplateBuildJobs({
		store: {},
		run: async () => {},
		logDir: "/logs",
	});
	assert.equal(jobs.logPath("a".repeat(24)), `/logs/${"a".repeat(24)}.log`);
	assert.equal(jobs.logPath("../etc/passwd"), null);
	assert.equal(
		new TemplateBuildJobs({ store: {}, run: async () => {} }).logPath(
			"a".repeat(24),
		),
		null,
	);
});
