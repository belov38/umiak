import { randomUUID } from "node:crypto";
import {
	finishNodeBuild,
	lockNode,
	lockNodeBuildCleanup,
} from "../../../packages/core/src/index.ts";
import { macFor } from "../../../packages/pve/src/allocator.ts";

const ownedTask = (task) => /^umiak@pve(?:!|$)/.test(String(task.user || ""));

function verifyTemplate(config) {
	if (
		Number(config.template) !== 1 ||
		!String(config.tags || "")
			.split(";")
			.includes("umiak-tpl")
	)
		throw Error("Refusing to delete an unverified template VM");
}

/** Retain the original intent/task through process loss and ambiguous PVE replies. */
export async function retireNodeTemplate({
	pool,
	service,
	node,
	build,
	limits,
	pve,
	probeLocal,
	taskUpid,
}) {
	if (build.status === "retired") return { ok: true };
	const prior = (
		await pool.query(
			"SELECT * FROM runtime.node_build_jobs WHERE retiring_build_id=$1",
			[build.id],
		)
	).rows[0];
	// The intent is recorded only after proving ownership, never for a missing VM.
	if (!prior)
		verifyTemplate(
			await pve.get(`/nodes/${node.name}/qemu/${build.pve_vmid}/config`),
		);
	const job = {
		id: prior?.id || `retire-${randomUUID()}`,
		nodeId: node.nodeId,
		slug: build.template_slug,
	};
	const runner = await pool.connect();
	let reserved = false;
	try {
		const locked = (
			await runner.query(
				"SELECT pg_try_advisory_lock(hashtextextended('template-runner:' || $1::text,0)) AS ok",
				[job.id],
			)
		).rows[0];
		if (!locked?.ok)
			throw Error(
				"Template retirement process is still alive; wait before retrying",
			);
		runner.on("error", () => process.kill(process.pid, "SIGKILL"));
		const needsWork = await service.transact(async (tx) => {
			await lockNode(tx, node.nodeId);
			await lockNodeBuildCleanup(tx, node.nodeId, "build");
			const current = (
				await tx.client.query(
					"SELECT status FROM runtime.template_builds WHERE id=$1 AND node_id=$2 FOR UPDATE",
					[build.id, node.nodeId],
				)
			).rows[0];
			if (current?.status === "retired") return false;
			if (!current) throw Error("Unknown template build");
			const open = (
				await tx.client.query(
					"SELECT id FROM runtime.node_build_jobs WHERE node_id=$1 AND status IN ('running','interrupted')",
					[node.nodeId],
				)
			).rows[0];
			if (open && open.id !== job.id)
				throw Error("Node has another unfinished build/preparation");
			const refs = await tx.client.query(
				"SELECT 1 FROM runtime.machines WHERE template_build_id=$1 AND state<>'deleted' UNION ALL SELECT 1 FROM runtime.snapshots WHERE template_build_id=$1 AND state<>'deleted' LIMIT 1",
				[build.id],
			);
			if (refs.rowCount)
				throw Error("Template still has machine or snapshot references");
			if (prior)
				await tx.client.query(
					"UPDATE runtime.node_build_jobs SET status='running',finished_at=NULL WHERE id=$1",
					[job.id],
				);
			else
				await tx.client.query(
					"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug,retiring_build_id) VALUES($1,$2,$3,$4)",
					[job.id, node.nodeId, build.template_slug, build.id],
				);
			const provider = (
				await tx.client.query(
					"SELECT cluster_mac_id FROM runtime.providers WHERE id=$1",
					[limits.providerId],
				)
			).rows[0];
			await tx.client.query(
				"INSERT INTO runtime.vmid_leases(provider_id,vmid,mac,state,purpose,build_job_id) VALUES($1,$2,$3,'active','template',$4) ON CONFLICT DO NOTHING",
				[
					limits.providerId,
					build.pve_vmid,
					macFor(provider.cluster_mac_id, build.pve_vmid),
					job.id,
				],
			);
			const lease = (
				await tx.client.query(
					"SELECT purpose,machine_id FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=$2",
					[limits.providerId, build.pve_vmid],
				)
			).rows[0];
			if (!lease || lease.purpose !== "template" || lease.machine_id !== null)
				throw Error(
					"Template VMID has a different lease owner; inspect before retirement",
				);
			await tx.client.query(
				"UPDATE runtime.template_builds SET status='deprecated' WHERE id=$1",
				[build.id],
			);
			return true;
		});
		if (!needsWork) return { ok: true };
		reserved = true;
		let task = prior?.pve_task_upid;
		// A lost DELETE response requires the operator to identify the actual PVE task.
		// Never infer completion from absence while an unrecorded delete may still arrive.
		if (!task && prior && taskUpid) {
			const status = await pve.get(
				`/nodes/${node.name}/tasks/${encodeURIComponent(taskUpid)}/status`,
			);
			if (
				status.type !== "qmdestroy" ||
				String(status.id) !== String(build.pve_vmid) ||
				!ownedTask(status) ||
				!Number.isFinite(Number(status.starttime)) ||
				Number(status.starttime) <
					Math.floor(new Date(prior.created_at).getTime() / 1000)
			)
				throw Error(
					"Recovery task does not match this retirement's VMID, user, type and start time",
				);
			task = taskUpid;
		}
		if (!task && prior?.pve_delete_requested_at)
			throw Error(
				"Retirement has no recorded PVE task; inspect task history and retry with taskUpid",
			);
		if (!task) {
			const active = await pve.get(`/nodes/${node.name}/tasks`, {
				source: "active",
			});
			if (active.some(ownedTask))
				throw Error(
					"Umiak PVE tasks are still running; retry retirement after completion",
				);
			verifyTemplate(
				await pve.get(`/nodes/${node.name}/qemu/${build.pve_vmid}/config`),
			);
			await pool.query(
				"UPDATE runtime.node_build_jobs SET pve_delete_requested_at=now() WHERE id=$1",
				[job.id],
			);
			task = await pve.delete(`/nodes/${node.name}/qemu/${build.pve_vmid}`);
		}
		await pool.query(
			"UPDATE runtime.node_build_jobs SET pve_task_upid=$2 WHERE id=$1",
			[job.id, task],
		);
		const deadline = Date.now() + 300000;
		let done = false;
		while (Date.now() < deadline) {
			const status = await pve.get(
				`/nodes/${node.name}/tasks/${encodeURIComponent(task)}/status`,
			);
			if (status.status === "stopped") {
				if (status.exitstatus !== "OK")
					throw Error(`Template deletion task: ${status.exitstatus}`);
				done = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		if (!done)
			throw Error(
				"Template deletion task is still running; reservation retained",
			);
		const active = await pve.get(`/nodes/${node.name}/tasks`, {
			source: "active",
		});
		const vms = await pve.get(`/nodes/${node.name}/qemu`);
		const local = await probeLocal({ op: "lv.list", args: {} });
		const prefix = new RegExp(`^(?:base|vm)-${build.pve_vmid}-`);
		if (
			active.some(ownedTask) ||
			vms.some((vm) => vm.vmid === build.pve_vmid) ||
			!Array.isArray(local.lvs) ||
			local.lvs.some((lv) => prefix.test(lv.name))
		)
			throw Error(
				"Template task, VM or local disks remain; retirement reservation retained",
			);
		await service.transact(async (tx) => {
			await lockNode(tx, node.nodeId);
			const foreign = await tx.client.query(
				"SELECT 1 FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=$2 AND (purpose<>'template' OR machine_id IS NOT NULL)",
				[limits.providerId, build.pve_vmid],
			);
			if (foreign.rowCount)
				throw Error(
					"Template VMID has a different lease owner; inspect before retirement",
				);
			await tx.client.query(
				"UPDATE runtime.template_builds SET status='retired' WHERE id=$1",
				[build.id],
			);
			await tx.client.query(
				"DELETE FROM runtime.vmid_leases WHERE provider_id=$1 AND vmid=$2 AND purpose='template' AND machine_id IS NULL",
				[limits.providerId, build.pve_vmid],
			);
			await finishNodeBuild(tx, {
				nodeId: node.nodeId,
				jobId: job.id,
				status: "succeeded",
			});
		});
		return { ok: true };
	} catch (error) {
		if (reserved) await service.interrupt(job);
		throw error;
	} finally {
		runner.release(true);
	}
}
