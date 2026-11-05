// Shared by console recovery, automatic rollback release and the owner wizard.
import { finishNodeBuild, lockNode } from "../../../packages/core/src/index.ts";
export async function cleanupBuild({
	service,
	node,
	request,
	state,
	limits,
	api,
	probe,
	secretsDir,
}) {
	return service.transact(async (tx) => {
		await lockNode(tx, node.nodeId);
		const job = (
			await tx.client.query(
				"SELECT status,template_slug,retiring_build_id,created_at FROM runtime.node_build_jobs WHERE id=$1 AND node_id=$2",
				[request.jobId, node.nodeId],
			)
		).rows[0];
		if (job?.retiring_build_id)
			throw Error(
				"Template retirement has a durable intent; retry retire-template with its buildId instead of cleanup-build",
			);
		if (
			!(
				["running", "interrupted"].includes(job?.status) ||
				(job?.status === "failed" && /^copy-[a-f0-9]{32}$/.test(request.jobId))
			) ||
			job.template_slug === "node-prepare"
		)
			throw Error(
				"Only an interrupted template build can be cleaned up; a running runner or node preparation must finish first",
			);
		const copyId = /^copy-([a-f0-9]{32})$/.exec(request.jobId)?.[1];
		if (copyId) {
			const copyLock = (
				await tx.client.query(
					"SELECT pg_try_advisory_xact_lock(hashtextextended('template-copy:' || source_id::text || ':' || target_node_id::text,0)) AS ok FROM runtime.volume_transfers WHERE id=$1 AND target_node_id=$2",
					[copyId, node.nodeId],
				)
			).rows[0];
			if (!copyLock?.ok)
				throw Error("Template copy is still running; wait before cleanup");
		}
		const runner = (
			await tx.client.query(
				"SELECT pg_try_advisory_xact_lock(hashtextextended('template-runner:' || $1::text,0)) AS ok",
				[request.jobId],
			)
		).rows[0];
		if (!runner?.ok)
			throw Error(
				"Template builder process is still alive; stop it before cleanup",
			);
		const pve = await api();
		const waitTask = async (upid) => {
			if (typeof upid !== "string" || !upid.startsWith("UPID:"))
				throw Error("PVE task identity is missing; reservation retained");
			for (let attempt = 0; attempt < 600; attempt++) {
				const status = await pve.get(
					`/nodes/${node.name}/tasks/${encodeURIComponent(upid)}/status`,
				);
				if (status.status === "stopped") {
					if (status.exitstatus !== "OK")
						throw Error(`Cleanup task failed: ${status.exitstatus}`);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			throw Error("Cleanup task timed out; reservation retained");
		};
		const tasks = await pve.get(`/nodes/${node.name}/tasks`, {
			source: "active",
		});
		if (tasks.some((t) => String(t.user || "").startsWith("umiak@pve")))
			throw Error(
				"Umiak PVE tasks are still running; wait for completion before cleanup",
			);
		const vms = await pve.get(`/nodes/${node.name}/qemu`);
		const leases = (
			await tx.client.query(
				"SELECT vmid FROM runtime.vmid_leases WHERE build_job_id=$1",
				[request.jobId],
			)
		).rows;
		if (copyId && !leases.length) {
			const journal = (
				await tx.client.query(
					"SELECT target_vmid FROM runtime.volume_transfers v WHERE id=$1 AND target_node_id=$2 AND phase NOT IN ('done','cancelled') AND NOT EXISTS (SELECT 1 FROM runtime.vmid_leases l WHERE l.vmid=v.target_vmid) AND NOT EXISTS (SELECT 1 FROM runtime.template_builds tb WHERE tb.pve_vmid=v.target_vmid)",
					[copyId, node.nodeId],
				)
			).rows[0];
			if (!journal)
				throw Error(
					"Replica lease/journal ownership cannot be verified; reservation retained",
				);
			leases.push({ vmid: journal.target_vmid });
		}
		const published = await tx.client.query(
			"SELECT pve_vmid FROM runtime.template_builds WHERE node_id=$1 AND status IN ('active','deprecated','retired') AND pve_vmid IN (SELECT vmid FROM runtime.vmid_leases WHERE build_job_id=$2)",
			[node.nodeId, request.jobId],
		);
		if (published.rows.length) {
			// Recover the old registration-before-copy crash boundary without deleting the template.
			for (const vm of vms.filter((v) =>
				leases.some((l) => Number(l.vmid) === Number(v.vmid)),
			)) {
				if (!published.rows.some((p) => Number(p.pve_vmid) === Number(vm.vmid)))
					throw Error(
						"Unpublished verification VM remains; reservation retained",
					);
				const cfg = await pve.get(`/nodes/${node.name}/qemu/${vm.vmid}/config`);
				if (
					vm.status !== "stopped" ||
					Number(cfg.template) !== 1 ||
					!/^umiak-/.test(cfg.name || "") ||
					(copyId && cfg.name !== `umiak-replica-${copyId}`) ||
					(!(copyId && cfg.name === `umiak-replica-${copyId}`) &&
						!String(cfg.tags || "")
							.split(/[;,]/)
							.some((t) => ["umiak", "umiak-tpl"].includes(t)))
				)
					throw Error(
						"Registered template ownership cannot be verified; reservation retained",
					);
			}
			if (request.inspect)
				return {
					jobId: request.jobId,
					vms: [],
					disks: [],
					unknown: [],
					registered: true,
				};
			await finishNodeBuild(tx, {
				nodeId: node.nodeId,
				jobId: request.jobId,
				status: "succeeded",
			});
			return { ok: true, registered: true };
		}
		const leased = new Set(leases.map((l) => Number(l.vmid)));
		const leftovers = vms.filter((vm) => leased.has(Number(vm.vmid)));
		const unknown = vms.filter(
			(vm) =>
				!leased.has(Number(vm.vmid)) &&
				((vm.vmid >= limits.vmidMin && vm.vmid <= limits.vmidMax) ||
					(vm.vmid >= limits.templateVmidMin &&
						vm.vmid <= limits.templateVmidMax)) &&
				vm.status !== "stopped",
		);

		const local = await probe(
			{
				...state.steps.connection.data,
				node: node.name,
				sshHost: node.sshHost,
			},
			secretsDir,
			{ op: "lv.list", args: {} },
		);
		if (!Array.isArray(local.lvs))
			throw Error("Cannot verify local disks; reservation retained");
		const disks = local.lvs.filter(
			(lv) =>
				leases.some((l) =>
					new RegExp(`^(?:base|vm)-${l.vmid}-`).test(lv.name),
				) ||
				(copyId &&
					new RegExp(`^umiak-(?:import|snap)-${copyId}-`).test(lv.name)),
		);
		if (request.inspect)
			return {
				jobId: request.jobId,
				createdAt: job.created_at,
				vms: leftovers,
				disks,
				unknown,
			};
		if (unknown.length)
			throw Error(
				`Unknown active VMs: ${unknown.map((v) => v.vmid).join(", ")}; reservation retained`,
			);
		if ((leftovers.length || disks.length) && request.confirmRemove !== true)
			throw Error("Build VMs/disks remain; confirm removal before retrying");
		// Preflight every resource before the first deletion. A lease alone cannot authorize a VM deletion.
		for (const vm of leftovers) {
			const cfg = await pve.get(`/nodes/${node.name}/qemu/${vm.vmid}/config`);
			if (
				Number(vm.vmid) === 590 ||
				Number(cfg.template) === 1 ||
				(!(copyId && cfg.name === `umiak-replica-${copyId}`) &&
					!String(cfg.tags || "")
						.split(/[;,]/)
						.some((t) => ["umiak-tpl", "umiak"].includes(t))) ||
				!/^umiak-/.test(cfg.name || "") ||
				(copyId && cfg.name !== `umiak-replica-${copyId}`)
			)
				throw Error(
					`VM ${vm.vmid} ownership cannot be verified; reservation retained`,
				);
		}
		for (const disk of disks) {
			if (!disk.tags?.includes("umiak") || /^(?:base|vm)-590-/.test(disk.name))
				throw Error(
					`Disk ${disk.name} ownership cannot be verified; reservation retained`,
				);
		}
		for (const vm of leftovers) {
			const path = `/nodes/${node.name}/qemu/${vm.vmid}`;
			if (vm.status !== "stopped")
				await waitTask(await pve.post(`${path}/status/stop`));
			await waitTask(
				await pve.request("DELETE", path, {
					purge: 1,
					"destroy-unreferenced-disks": 0,
				}),
			);
		}
		const connection = {
			...state.steps.connection.data,
			node: node.name,
			sshHost: node.sshHost,
		};
		const remaining = await probe(connection, secretsDir, {
			op: "lv.list",
			args: {},
		});
		if (!Array.isArray(remaining.lvs))
			throw Error("Cannot verify local disks; reservation retained");
		const names = remaining.lvs
			.filter((lv) => disks.some((d) => d.name === lv.name))
			.map((lv) => lv.name);
		if (names.length)
			await probe(connection, secretsDir, { op: "lv.remove", args: { names } });
		const finalVms = await pve.get(`/nodes/${node.name}/qemu`);
		const finalDisks = await probe(connection, secretsDir, {
			op: "lv.list",
			args: {},
		});
		if (
			finalVms.some((v) => leased.has(Number(v.vmid))) ||
			!Array.isArray(finalDisks.lvs) ||
			finalDisks.lvs.some(
				(lv) =>
					leases.some((l) =>
						new RegExp(`^(?:base|vm)-${l.vmid}-`).test(lv.name),
					) ||
					(copyId &&
						new RegExp(`^umiak-(?:import|snap)-${copyId}-`).test(lv.name)),
			)
		)
			throw Error("Build resources remain; reservation retained");

		await tx.client.query(
			"DELETE FROM runtime.vmid_leases WHERE build_job_id=$1",
			[request.jobId],
		);
		if (copyId)
			await tx.client.query(
				"UPDATE runtime.volume_transfers SET phase='cancelled',updated_at=now() WHERE id=$1",
				[copyId],
			);
		if (job.status !== "failed")
			await finishNodeBuild(tx, {
				nodeId: node.nodeId,
				jobId: request.jobId,
				status: "failed",
			});
		return { ok: true };
	});
}
