import assert from "node:assert/strict";
import test from "node:test";
import {
	recordReplicaChecksums,
	replicateActiveTemplates,
} from "./template-replication.mjs";

test("a runner waiting for the copy lock rechecks publication before allocating another replica", async () => {
	let locked = false;
	const events = [];
	const pool = {
		connect: async () => ({
			query: async (sql) => {
				if (sql.includes("pg_advisory_lock")) locked = true;
			},
			release() {},
		}),
		query: async (sql) => {
			assert.ok(!sql.includes("INSERT"));
			events.push(sql);
			if (sql.includes("SELECT n.id"))
				return {
					rows: [
						{ nodeId: "source", name: "pve" },
						{ nodeId: "target", name: "pve2" },
					],
				};
			if (sql.includes("SELECT tb.*"))
				return {
					rows: [{ id: "root", node_id: "source", template_slug: "linux" }],
				};
			if (sql.includes("SELECT * FROM runtime.volume_transfers"))
				return { rows: [{ id: "copy", phase: "done" }] };
			if (sql.includes("runtime.template_builds WHERE node_id"))
				return { rowCount: locked ? 1 : 0, rows: [] };
			throw Error(sql);
		},
	};
	const progress = [];
	await replicateActiveTemplates({
		pool,
		state: { steps: { limits: { data: { providerId: "provider" } } } },
		api: {},
		onProgress: async (p) => progress.push(p),
	});
	assert.deepEqual(progress, [
		{ phase: "ready", node: "pve2", nodeId: "target" },
	]);
	assert.ok(events.some((sql) => sql.includes("volume_transfers")));
});

test("checksum format upgrade changes only replicas with an equal verified legacy proof", async () => {
	const old = {
			scsi0: {
				sha256: "a".repeat(64),
				algorithm: "sha256-block-tree-v1",
				sizeBytes: 512,
			},
		},
		next = {
			scsi0: {
				sha256: "b".repeat(64),
				algorithm: "sha256-pvesm-raw+size-v1",
				sizeBytes: 512,
			},
		};
	const queries = [];
	await recordReplicaChecksums(
		{ client: { query: async (...args) => queries.push(args) } },
		{ id: "source", provider_id: "provider", checksums: old },
		"root",
		next,
	);
	assert.equal(queries.length, 2);
	assert.match(queries[0][0], /checksums=\$4::jsonb/);
	assert.deepEqual(queries[0][1], [
		"provider",
		"root",
		JSON.stringify(next),
		JSON.stringify(old),
	]);
});
test("an immutable source with an existing raw checksum cannot change bytes", async () => {
	const old = {
			scsi0: {
				sha256: "a".repeat(64),
				algorithm: "sha256-pvesm-raw+size-v1",
				sizeBytes: 512,
			},
		},
		next = { scsi0: { ...old.scsi0, sha256: "b".repeat(64) } };
	let wrote = false;
	await assert.rejects(
		recordReplicaChecksums(
			{
				client: {
					query: async () => {
						wrote = true;
					},
				},
			},
			{ id: "source", provider_id: "provider", checksums: old },
			"root",
			next,
		),
		/Immutable source/,
	);
	assert.equal(wrote, false);
});
