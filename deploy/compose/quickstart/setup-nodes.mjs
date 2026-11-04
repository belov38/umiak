import {
	beginNodeBuild,
	finishNodeBuild,
	interruptNodeBuild,
	lockNode,
	promoteNodeTemplate,
	registerSandboxNode,
	sandboxNodeInventory,
} from "../../../packages/core/src/index.ts";
import { withTx } from "../../../packages/db/src/tx.ts";

/** A copy of installer facts scoped to a DB-registered target, never browser SSH fields. */
export function scopedNodeState(state, node) {
	const next = structuredClone(state);
	next.steps.connection.data = {
		...next.steps.connection.data,
		node: node.name,
		sshHost: node.sshHost,
	};
	next.steps.limits.data = {
		...next.steps.limits.data,
		providerId: node.providerId,
		nodeId: node.nodeId,
		storageId: node.storageId,
		storage: node.storage,
		ramCapMb: node.ramCapMb,
	};
	next.mediaStorage = node.mediaStorage;
	return next;
}
export function nodeService(pool) {
	const transact = (fn) => withTx(pool, fn);
	return {
		async installerNodeRetired(state) {
			const id = state.steps?.limits?.data?.nodeId;
			if (!id) return false;
			return Boolean(
				(
					await pool.query("SELECT retired_at FROM runtime.nodes WHERE id=$1", [
						id,
					])
				).rows[0]?.retired_at,
			);
		},
		list: (providerId) => sandboxNodeInventory(pool, providerId),
		async select(state, nodeId) {
			const list = await sandboxNodeInventory(
				pool,
				state.steps.limits.data.providerId,
			);
			if (!nodeId && list.length !== 1) throw Error("Select a sandbox node");
			const node = list.find((n) => n.nodeId === (nodeId || list[0]?.nodeId));
			if (node?.state !== "active")
				throw Error("Unknown or inactive sandbox node");
			return scopedNodeState(state, node);
		},
		async register(input, { preserveState = false } = {}) {
			return transact(async (tx) => {
				// An Update bootstrap must not undo an explicit operator cordon/retirement,
				// overwrite day-2 per-node limits, or fail because this node is building.
				const existing = await tx.client.query(
					"SELECT id FROM runtime.nodes WHERE provider_id=$1 AND name=$2",
					[input.providerId, input.name],
				);
				const id = existing.rows[0]?.id;
				if (preserveState && id) {
					await lockNode(tx, id);
					const storage = await tx.client.query(
						"SELECT id FROM runtime.storages WHERE node_id=$1 AND name=$2 AND driver='lvmthin'",
						[id, input.storage],
					);
					if (!storage.rows[0])
						throw Error(
							"Installer storage differs from registered node; inspect inventory",
						);
					return { nodeId: id, storageId: storage.rows[0].id };
				}
				return registerSandboxNode(tx, input);
			});
		},
		reserve: (job) =>
			transact((tx) =>
				beginNodeBuild(tx, {
					nodeId: job.nodeId,
					jobId: job.id,
					templateSlug: job.slug,
				}),
			),
		interrupt: (job, state) =>
			transact(async (tx) => {
				if (!job.nodeId) {
					job.nodeId = state.steps.limits.data.nodeId;
					await lockNode(tx, job.nodeId);
					await tx.client.query(
						"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug,status) VALUES($1,$2,$3,'interrupted') ON CONFLICT(id) DO NOTHING",
						[job.id, job.nodeId, job.slug],
					);
				}
				await interruptNodeBuild(tx, job.nodeId, job.id);
			}),
		finish: (job) =>
			transact((tx) =>
				finishNodeBuild(tx, {
					nodeId: job.nodeId,
					jobId: job.id,
					status: "succeeded",
				}),
			),
		registerTemplate: (input, jobId) =>
			transact(async (tx) => {
				await lockNode(tx, input.nodeId);
				const r = await tx.client.query(
					`INSERT INTO runtime.template_builds(template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,agent_version,boot_timeout_s,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'building') RETURNING id`,
					[
						input.templateSlug,
						input.version,
						input.os,
						input.providerId,
						input.nodeId,
						input.storageId,
						input.pveVmid,
						JSON.stringify(input.diskLayout),
						JSON.stringify(input.hw),
						input.agentVersion,
						input.bootTimeoutS,
					],
				);
				const id = r.rows[0].id;
				await promoteNodeTemplate(tx, {
					nodeId: input.nodeId,
					buildId: id,
					...(jobId ? { jobId } : {}),
				});
				return { id };
			}),
		promote: (input) => transact((tx) => promoteNodeTemplate(tx, input)),
		transact,
	};
}
