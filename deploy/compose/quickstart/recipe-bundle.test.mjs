import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	platformReleaseChannel,
	selectRecipeRelease,
} from "../release-channel.mjs";
import { verifyRecipeBundle } from "./recipe-bundle.mjs";
import { idleForRecipeBuild, RecipeChannel } from "./recipe-channel.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
function bundle(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), "recipe-test-"));
	try {
		writeFileSync(
			join(dir, "channel.json"),
			JSON.stringify({
				version: "20261105.1",
				builderApi: 1,
				minPlatform: "0.1.0",
				maxPlatform: "0.2.0",
				minAgent: "0.1.0",
				changelog: "pins",
				...overrides,
			}),
		);
		for (const slug of ["linux", "debian", "linux-desktop", "windows"]) {
			mkdirSync(join(dir, "infra/templates", slug), { recursive: true });
			writeFileSync(
				join(dir, "infra/templates", slug, "template.yaml"),
				`slug: ${slug}`,
			);
		}
		execFileSync("tar", [
			"--format=ustar",
			"-cf",
			join(dir, "test.tar"),
			"-C",
			dir,
			"channel.json",
			"infra/templates",
		]);
		const archive = readFileSync(join(dir, "test.tar"));
		const sums = Buffer.from(
			`${createHash("sha256").update(archive).digest("hex")}  recipes.tar\n`,
		);
		return {
			archive,
			sums,
			signature: sign(null, sums, privateKey),
			keys: [publicKey],
			platform: "0.1.0",
			agent: "0.1.0",
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
test("signed checksum and compatibility gate recipe use", () => {
	const b = bundle();
	assert.equal(verifyRecipeBundle(b).manifest.version, "20261105.1");
	assert.throws(
		() => verifyRecipeBundle({ ...b, signature: Buffer.alloc(64) }),
		/signature/,
	);
	assert.throws(
		() => verifyRecipeBundle({ ...b, archive: Buffer.from("corrupt") }),
		/checksum/,
	);
	for (const field of [
		{ minPlatform: "0.2.0" },
		{ minAgent: "0.2.0" },
		{ maxPlatform: "0.1.0" },
		{ builderApi: 2 },
	])
		assert.throws(() => verifyRecipeBundle(bundle(field)), /incompatible/);
});
test("exact stable and edge selection follows platform", () => {
	const releases = [
		{ tag_name: "recipes-20261105.1", prerelease: false },
		{ tag_name: "recipes-20261105.1-edge.20261105.2", prerelease: true },
	];
	assert.equal(selectRecipeRelease(releases).tag_name, releases[0].tag_name);
	assert.equal(
		selectRecipeRelease(releases, "edge").tag_name,
		releases[1].tag_name,
	);
	assert.equal(
		platformReleaseChannel({ platform: { channel: "edge" } }, {}),
		"edge",
	);
	assert.equal(platformReleaseChannel({}, {}), "stable");
	assert.throws(() =>
		platformReleaseChannel({ platform: { channel: "beta" } }, {}),
	);
});
test("idle admission never selects a busy or reserved node", () => {
	assert.equal(idleForRecipeBuild({ state: "active", running: 0 }), true);
	for (const node of [
		{ state: "cordoned" },
		{ state: "active", running: 1 },
		{ state: "active", buildJobId: "job" },
	])
		assert.equal(idleForRecipeBuild(node), false);
});
test("pause and overlapping ticks do not launch work", async () => {
	const state = {
		recipeChannel: { enabled: false, auto: true, intervalHours: 24 },
	};
	const c = new RecipeChannel({
		jobs: {
			store: { read: async () => state },
			update: async (fn) => fn(state),
		},
		fetcher: () => {
			throw Error("must not fetch");
		},
		rollout: () => {
			throw Error("must not build");
		},
	});
	await c.tick();
	assert.equal(state.recipeChannel.error, undefined);
	await c.settings({ auto: false, intervalHours: 1 });
	assert.equal(state.recipeChannel.auto, false);
	await assert.rejects(c.settings({ intervalHours: 0 }));
});

test("rollback refuses missing disks and promotes only a verified deprecated build", async () => {
	const { rollbackRecipe } = await import("./recipe-rollback.mjs");
	let promoted = 0;
	const opts = {
		build: {
			id: "build",
			node_id: "node",
			pve_vmid: 600,
			status: "deprecated",
			manifest: { verify: { ok: true } },
		},
		state: {},
		nodes: {
			select: async () => ({}),
			promote: async () => {
				promoted++;
			},
		},
		connectionOf: () => ({ node: "pve" }),
		pveOf: async () => ({
			get: async () => ({
				template: 1,
				scsi0: "local-lvm:base-600-disk-0,size=8G",
			}),
		}),
		nodeCheck: async () => ({ lvs: [] }),
	};
	await assert.rejects(rollbackRecipe(opts), /disks unavailable/);
	assert.equal(promoted, 0);
	await rollbackRecipe({
		...opts,
		nodeCheck: async () => ({ lvs: [{ name: "base-600-disk-0" }] }),
	});
	assert.equal(promoted, 1);
	await assert.rejects(
		rollbackRecipe({ ...opts, build: { ...opts.build, status: "retired" } }),
		/verified/,
	);
});

test("rollout waits for running guests and records verified build completion", async () => {
	const { recipeRollout } = await import("./recipe-rollout.mjs");
	let launched = 0,
		running = true;
	const state = {
		steps: { limits: { data: { providerId: "p" } }, network: { data: {} } },
		bootstrap: { publicUrl: "https://umiak.test" },
		recipeChannel: {},
	};
	const jobs = {
		store: { read: async () => state },
		update: async (fn) => fn(state),
		start: async () => {
			launched++;
		},
		settled: async () => {
			state.buildJob = { status: "ready" };
		},
	};
	const channel = recipeRollout({
		jobs,
		store: jobs.store,
		nodes: {
			list: async () => [{ nodeId: "n", name: "pve", state: "active" }],
			select: async () => ({
				steps: { limits: { data: { vmidMin: 500, vmidMax: 589 } } },
			}),
		},
		query: async (sql) => ({
			rows: sql.includes("status='active'")
				? [{ template_slug: "linux", manifest: {} }]
				: [],
		}),
		pveOf: async () => ({
			get: async () => [{ vmid: 500, status: running ? "running" : "stopped" }],
		}),
		connectionOf: () => ({ node: "pve" }),
	});
	await channel.rollout({ version: "20261105.1" }, state);
	assert.equal(launched, 0);
	assert.match(state.recipeChannel.progress, /idle/);
	running = false;
	await channel.rollout({ version: "20261105.1" }, state);
	assert.equal(launched, 1);
	assert.equal(state.recipeChannel.history[0].status, "ready");
});
test("retirement refuses machine, snapshot and transfer references before deleting", async () => {
	const { retireNodeTemplate } = await import("./node-template-retirement.mjs");
	let deleted = false;
	const query = async (sql) => {
		if (sql.includes("pg_try_advisory_lock")) return { rows: [{ ok: true }] };
		if (sql.includes("SELECT status FROM runtime.template_builds"))
			return { rows: [{ status: "deprecated" }] };
		if (sql.includes("UNION ALL SELECT 1 FROM runtime.snapshots")) {
			assert.match(sql, /volume_transfers WHERE kind='template'/);
			assert.match(sql, /phase NOT IN \('done','cancelled'\)/);
			return { rowCount: 1, rows: [{}] };
		}
		if (sql.includes("INSERT") || sql.includes("UPDATE"))
			throw Error("must not mutate with references");
		return { rows: [], rowCount: 0 };
	};
	const client = { query, on: () => {}, release: () => {} };
	await assert.rejects(
		retireNodeTemplate({
			pool: { query, connect: async () => client },
			service: { transact: (fn) => fn({ client }) },
			node: { nodeId: "n", name: "pve" },
			build: { id: "b", pve_vmid: 600, status: "deprecated" },
			limits: {},
			pve: {
				get: async () => ({ template: 1, tags: "umiak-tpl" }),
				delete: async () => {
					deleted = true;
				},
			},
		}),
		/references/,
	);
	assert.equal(deleted, false);
});

test("the baked publisher key is a usable Ed25519 public key", async () => {
	const { publisherKeys } = await import("./recipe-channel.mjs");
	const { createPublicKey } = await import("node:crypto");
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const keys = await publisherKeys(
		await mkdtemp(join(tmpdir(), "umiak-keys-")),
	);
	assert.equal(keys.length, 1);
	assert.equal(createPublicKey(keys[0]).asymmetricKeyType, "ed25519");
});
