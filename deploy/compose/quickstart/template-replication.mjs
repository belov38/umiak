// Durable build-once replication. Privileged operations use only node-agent RPCs.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	lockNode,
	promoteNodeTemplate,
} from "../../../packages/core/src/index.ts";
import { withTx } from "../../../packages/db/src/tx.ts";
import { macFor } from "../../../packages/pve/src/allocator.ts";
import { SshNodeOps } from "../../../packages/pve/src/node-client.ts";
import { replicateTemplate } from "../../../packages/pve/src/template-replication.ts";
import { checkNode } from "./setup-host.mjs";
import { scopedNodeState } from "./setup-nodes.mjs";
import { templateRange } from "./setup-vmids.mjs";

export async function replicateActiveTemplates({
	pool,
	state,
	targetNodeId,
	sourceBuildId,
	api,
	nodeCheck,
	secretsDir,
	onProgress = async () => {},
}) {
	const topology = (
		await pool.query(
			`SELECT n.id AS "nodeId",n.name,n.provider_id AS "providerId",n.node_agent_ref AS "sshHost",n.ram_cap_mb AS "ramCapMb",n.media_storage AS "mediaStorage",s.id AS "storageId",s.name AS storage,p.cluster_mac_id FROM runtime.nodes n JOIN runtime.providers p ON p.id=n.provider_id JOIN runtime.storages s ON s.node_id=n.id AND s.driver='lvmthin' WHERE n.provider_id=$1 AND n.retired_at IS NULL AND n.state='active' ORDER BY n.id`,
			[state.steps.limits.data.providerId],
		)
	).rows;
	const builds = (
		await pool.query(
			`SELECT tb.* FROM runtime.template_builds tb WHERE tb.provider_id=$1 AND tb.status='active' AND ($2::uuid IS NULL OR tb.id=$2) ORDER BY tb.template_slug,(tb.source_build_id IS NOT NULL),tb.created_at DESC`,
			[state.steps.limits.data.providerId, sourceBuildId ?? null],
		)
	).rows;
	const latest = new Map();
	for (const b of builds)
		if (!latest.has(b.template_slug)) latest.set(b.template_slug, b);
	const taskApi = {
		...api,
		put: (path, data) => api.request("PUT", path, data),
		waitTask: async (node, upid) => {
			for (let i = 0; i < 1200; i++) {
				const status = await api.get(
					`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
				);
				if (status.status === "stopped") {
					if (status.exitstatus !== "OK")
						throw Error(`Replica task failed: ${status.exitstatus}`);
					return;
				}
				await new Promise((r) => setTimeout(r, 1000));
			}
			throw Error("Replica PVE task timed out");
		},
	};
	const channels = new Map();
	const call = (node) => ({
		close() {},
		async call(op, args) {
			if (nodeCheck !== checkNode)
				return nodeCheck(
					scopedNodeState(state, node).steps.connection.data,
					secretsDir,
					{ op, args },
				);
			let client = channels.get(node.nodeId);
			if (!client) {
				client = Promise.all([
					readFile(join(secretsDir, "umiak-node_ed25519")),
					readFile(join(secretsDir, "known_hosts"), "utf8"),
				]).then(
					([privateKey, knownHosts]) =>
						new SshNodeOps({
							host: node.sshHost,
							privateKey,
							knownHosts,
							callTimeoutMs: 120000,
						}),
				);
				channels.set(node.nodeId, client);
			}
			return (await client).call(op, args);
		},
	});
	try {
		for (const source of latest.values())
			for (const target of topology) {
				if (
					target.nodeId === source.node_id ||
					(targetNodeId && target.nodeId !== targetNodeId)
				)
					continue;
				const root = source.source_build_id ?? source.id;
				if (
					(
						await pool.query(
							`SELECT id FROM runtime.template_builds WHERE node_id=$1 AND status='active' AND (id=$2 OR source_build_id=$2)`,
							[target.nodeId, root],
						)
					).rowCount &&
					!(
						await pool.query(
							"SELECT 1 FROM runtime.volume_transfers WHERE kind='template' AND source_id=$1 AND target_node_id=$2 AND phase NOT IN ('done','cancelled')",
							[root, target.nodeId],
						)
					).rowCount
				)
					continue;
				const origin = topology.find((n) => n.nodeId === source.node_id);
				if (!origin) throw Error("Template source node is unavailable");
				// A session lock covers host actions; the journal survives process death.
				const conn = await pool.connect();
				const key = `template-copy:${root}:${target.nodeId}`;
				try {
					await conn.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
						key,
					]);
					let journal = (
						await pool.query(
							`SELECT * FROM runtime.volume_transfers WHERE kind='template' AND source_id=$1 AND target_node_id=$2 ORDER BY created_at DESC LIMIT 1`,
							[root, target.nodeId],
						)
					).rows[0];
					if (journal?.phase === "done" || journal?.phase === "cancelled")
						journal = undefined;
					if (!journal) {
						const id = randomBytes(16).toString("hex");
						const job = `copy-${id}`;
						const resources = await api.get("/cluster/resources");
						const occupied = new Set(resources.map((r) => Number(r.vmid)));
						const range = templateRange(state);
						journal = await withTx(pool, async (tx) => {
							for (const id of [origin.nodeId, target.nodeId].sort())
								await lockNode(tx, id);
							const present = (
								await tx.client.query(
									"SELECT 1 FROM runtime.template_builds WHERE id=$1 AND status='active'",
									[source.id],
								)
							).rowCount;
							if (!present) throw Error("Template source is no longer active");
							const eligible = (
								await tx.client.query(
									"SELECT 1 FROM runtime.nodes WHERE id=$1 AND state='active' AND retired_at IS NULL",
									[target.nodeId],
								)
							).rowCount;
							if (!eligible) throw Error("Replica target no longer eligible");
							await tx.client.query(
								"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,$3)",
								[job, target.nodeId, source.template_slug],
							);
							let vmid;
							for (
								let v = range.templateVmidMin;
								v <= range.templateVmidMax;
								v++
							) {
								if (occupied.has(v)) continue;
								const r = await tx.client.query(
									`INSERT INTO runtime.vmid_leases(provider_id,vmid,mac,state,purpose,build_job_id) VALUES($1,$2,$3,'reserved','template',$4) ON CONFLICT DO NOTHING`,
									[
										source.provider_id,
										v,
										macFor(target.cluster_mac_id, v),
										job,
									],
								);
								if (r.rowCount) {
									vmid = v;
									break;
								}
							}
							if (!vmid)
								throw Error("No free cluster-unique template VMID for replica");
							return (
								await tx.client.query(
									`INSERT INTO runtime.volume_transfers(id,kind,source_id,source_node_id,target_node_id,target_storage_id,target_vmid) VALUES($1,'template',$2,$3,$4,$5,$6) RETURNING *`,
									[
										id,
										root,
										source.node_id,
										target.nodeId,
										target.storageId,
										vmid,
									],
								)
							).rows[0];
						});
					}
					if (journal.phase === "committed") {
						await call(target).call("lv.remove", {
							names: Object.keys(journal.result.checksums).map(
								(slot) => `umiak-snap-${journal.id}-${slot}`,
							),
						});
						await withTx(pool, async (tx) => {
							await lockNode(tx, target.nodeId);
							await tx.client.query(
								"UPDATE runtime.node_build_jobs SET status='succeeded',finished_at=now() WHERE id=$1",
								[`copy-${journal.id}`],
							);
							await tx.client.query(
								"UPDATE runtime.volume_transfers SET phase='done',updated_at=now() WHERE id=$1",
								[journal.id],
							);
						});
						continue;
					}

					const progress = journal.progress ?? {};
					await onProgress({
						phase: "copying",
						node: target.name,
						nodeId: target.nodeId,
						verifiedBytes: 0,
						totalBytes: 0,
					});
					const checksums = await replicateTemplate({
						api: taskApi,
						source: call(origin),
						target: call(target),
						sourceNode: origin.name,
						targetNode: target.name,
						sourceStorage: origin.storage,
						targetStorage: target.storage,
						sourceVmid: source.pve_vmid,
						targetVmid: journal.target_vmid,
						id: journal.id,
						progress,
						checkpoint: async (slot, p) => {
							progress[slot] = p.verifiedBytes;
							await pool.query(
								"UPDATE runtime.volume_transfers SET phase='copying',progress=$2,updated_at=now() WHERE id=$1",
								[journal.id, JSON.stringify(progress)],
							);
							await onProgress({
								phase: "copying",
								node: target.name,
								nodeId: target.nodeId,
								slot,
								...p,
							});
						},
					});
					await withTx(pool, async (tx) => {
						await lockNode(tx, target.nodeId);
						const existing = (
							await tx.client.query(
								"SELECT id FROM runtime.template_builds WHERE source_build_id=$1 AND node_id=$2 AND status<>'retired'",
								[root, target.nodeId],
							)
						).rows[0];
						const build =
							existing ??
							(
								await tx.client.query(
									`INSERT INTO runtime.template_builds(template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,agent_version,boot_timeout_s,status,source_build_id,manifest,checksums) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'building',$12,$13,$14) RETURNING id`,
									[
										source.template_slug,
										source.version,
										source.os,
										source.provider_id,
										target.nodeId,
										target.storageId,
										journal.target_vmid,
										JSON.stringify(source.disk_layout),
										JSON.stringify(source.hw),
										source.agent_version,
										source.boot_timeout_s,
										root,
										JSON.stringify(source.manifest),
										JSON.stringify(checksums),
									],
								)
							).rows[0];
						await tx.client.query(
							"UPDATE runtime.template_builds SET checksums=COALESCE(checksums,$2) WHERE id=$1",
							[source.id, JSON.stringify(checksums)],
						);
						await promoteNodeTemplate(tx, {
							nodeId: target.nodeId,
							buildId: build.id,
							jobId: `copy-${journal.id}`,
						});
						await tx.client.query(
							"UPDATE runtime.volume_transfers SET phase='committed',result=$2,updated_at=now() WHERE id=$1",
							[journal.id, JSON.stringify({ buildId: build.id, checksums })],
						);
						await tx.client.query(
							"UPDATE runtime.vmid_leases SET state='active' WHERE provider_id=$1 AND vmid=$2 AND build_job_id=$3",
							[source.provider_id, journal.target_vmid, `copy-${journal.id}`],
						);
					});
					await call(target).call("lv.remove", {
						names: Object.keys(checksums).map(
							(slot) => `umiak-snap-${journal.id}-${slot}`,
						),
					});
					await withTx(pool, async (tx) => {
						await lockNode(tx, target.nodeId);
						await tx.client.query(
							"UPDATE runtime.node_build_jobs SET status='succeeded',finished_at=now() WHERE id=$1",
							[`copy-${journal.id}`],
						);
						await tx.client.query(
							"UPDATE runtime.volume_transfers SET phase='done',updated_at=now() WHERE id=$1",
							[journal.id],
						);
					});
					await onProgress({
						phase: "ready",
						node: target.name,
						nodeId: target.nodeId,
					});
				} finally {
					await conn
						.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key])
						.catch(() => {});
					conn.release();
				}
			}
	} finally {
		for (const client of channels.values())
			await client.then((c) => c.close()).catch(() => {});
	}
}
