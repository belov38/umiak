// Console-only installer bridge. No HTTP endpoint and no host shell credentials.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
	beginNodeBuild,
	finishNodeBuild,
	lockNode,
	lockNodeBuildCleanup,
	registerSandboxNode,
	retireNode,
} from "../../../packages/core/src/index.ts";
import pg from "../../../packages/db/node_modules/pg/lib/index.js";
import { PgSetupStore } from "./setup.mjs";
import { checkNode, pinnedPve } from "./setup-host.mjs";
import { nodeService } from "./setup-nodes.mjs";

export async function nodeCommand(
	pool,
	request,
	{
		secretsDir = process.env.UMIAK_SECRETS_DIR || "/pve-secrets",
		probe = checkNode,
		makePve = pinnedPve,
	} = {},
) {
	const state = await new PgSetupStore(pool).read();
	const limits = state.steps?.limits?.data;
	if (!limits?.providerId)
		throw Error("Finish the installer bootstrap before managing nodes");
	const service = nodeService(pool);
	const api = async () =>
		makePve(
			state.steps.connection.data,
			(await readFile(`${secretsDir}/pve-token`, "utf8")).trim(),
		);
	if (request.op === "capabilities") {
		const schema = (
			await pool.query(
				"SELECT to_regclass('runtime.node_build_jobs') IS NOT NULL AND (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='runtime' AND table_name='nodes' AND column_name IN ('retired_at','media_storage')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='runtime' AND table_name='vmid_leases' AND column_name='build_job_id') AS ready",
			)
		).rows[0];
		return { multiNode: Boolean(schema?.ready) };
	}
	if (request.op === "list")
		return {
			nodes: await service.list(limits.providerId),
			builds: (
				await pool.query(
					"SELECT id,node_id,template_slug,version,pve_vmid,status FROM runtime.template_builds WHERE provider_id=$1 ORDER BY node_id,template_slug,created_at",
					[limits.providerId],
				)
			).rows,
			retiredNodes: (
				await pool.query(
					'SELECT id AS "nodeId",name FROM runtime.nodes WHERE provider_id=$1 AND retired_at IS NOT NULL',
					[limits.providerId],
				)
			).rows,
			limits,
		};
	if (request.op === "prepare-add") {
		const cfg = { ...request.node, providerId: limits.providerId };
		return service.transact(async (tx) => {
			// register validates storage changes and capacity before any host mutation.
			const existing = (
				await tx.client.query(
					"SELECT id FROM runtime.nodes WHERE provider_id=$1 AND name=$2",
					[cfg.providerId, cfg.name],
				)
			).rows[0];
			if (existing) {
				await lockNode(tx, existing.id);
				const open = (
					await tx.client.query(
						"SELECT id,template_slug FROM runtime.node_build_jobs WHERE node_id=$1 AND status IN ('running','interrupted')",
						[existing.id],
					)
				).rows[0];
				if (open) {
					const staged = (
						await tx.client.query(
							"SELECT n.node_agent_ref,n.ram_cap_mb,n.media_storage,s.name AS storage FROM runtime.nodes n JOIN runtime.storages s ON s.node_id=n.id AND s.driver='lvmthin' WHERE n.id=$1",
							[existing.id],
						)
					).rows[0];
					if (
						open.template_slug !== "node-prepare" ||
						staged.node_agent_ref !== cfg.sshHost ||
						staged.ram_cap_mb !== cfg.ramCapMb ||
						staged.media_storage !== cfg.mediaStorage ||
						staged.storage !== cfg.storage
					)
						throw Error(
							"Unfinished preparation/build exists; retry the same node configuration",
						);
					return { ok: true, nodeId: existing.id, preparationId: open.id };
				}
			}
			const registered = await registerSandboxNode(tx, cfg);
			const id = `prepare-${randomUUID()}`;
			await beginNodeBuild(tx, {
				nodeId: registered.nodeId,
				jobId: id,
				templateSlug: "node-prepare",
			});
			await tx.client.query(
				"UPDATE runtime.nodes SET state='cordoned' WHERE id=$1",
				[registered.nodeId],
			);
			return { ok: true, ...registered, preparationId: id };
		});
	}
	if (request.op === "register") {
		const cfg = { ...request.node, providerId: limits.providerId };
		const members = await (await api()).get("/nodes");
		if (!members.some((n) => n.node === cfg.name && n.status === "online"))
			throw Error("Target is not an online PVE cluster member");
		const agent = await probe(
			{ ...state.steps.connection.data, node: cfg.name, sshHost: cfg.sshHost },
			secretsDir,
		);
		for (const [key, value] of Object.entries({
			node: cfg.name,
			storage: cfg.storage,
			vmidMin: limits.vmidMin,
			vmidMax: limits.vmidMax,
			templateVmidMin: limits.templateVmidMin,
			templateVmidMax: limits.templateVmidMax,
			vnet: "umiak0",
		})) {
			if (agent.config?.[key] !== value)
				throw Error(`Restricted node-agent configuration mismatch: ${key}`);
		}
		if (!agent.version) throw Error("Restricted node-agent version is missing");
		const st = await (await api()).get(
			`/nodes/${cfg.name}/storage/${cfg.storage}/status`,
		);
		if (st.type !== "lvmthin" || Number(st.active ?? 1) !== 1)
			throw Error("Node storage is not active LVM-thin");
		return service.transact(async (tx) => {
			const existing = (
				await tx.client.query(
					"SELECT id FROM runtime.nodes WHERE provider_id=$1 AND name=$2",
					[cfg.providerId, cfg.name],
				)
			).rows[0];
			if (!existing)
				throw Error("Reserve node preparation before registration");
			await lockNode(tx, existing.id);
			const job = (
				await tx.client.query(
					"SELECT id FROM runtime.node_build_jobs WHERE id=$1 AND node_id=$2 AND template_slug='node-prepare' AND status IN ('running','interrupted')",
					[request.preparationId, existing.id],
				)
			).rows[0];
			if (!job) throw Error("Missing matching node preparation reservation");
			const staged = (
				await tx.client.query(
					"SELECT n.node_agent_ref,n.ram_cap_mb,n.media_storage,s.name AS storage FROM runtime.nodes n JOIN runtime.storages s ON s.node_id=n.id AND s.driver='lvmthin' WHERE n.id=$1",
					[existing.id],
				)
			).rows[0];
			if (
				staged.node_agent_ref !== cfg.sshHost ||
				staged.ram_cap_mb !== cfg.ramCapMb ||
				staged.media_storage !== cfg.mediaStorage ||
				staged.storage !== cfg.storage
			)
				throw Error("Prepared node configuration differs from its reservation");
			await finishNodeBuild(tx, {
				nodeId: existing.id,
				jobId: job.id,
				status: "succeeded",
			});
			return { ok: true, ...(await registerSandboxNode(tx, cfg)) };
		});
	}
	const inventory = await service.list(limits.providerId);
	const node = inventory.find((n) => n.nodeId === request.nodeId);
	if (request.op === "retire") {
		// Idempotent retries can still address an already retired topology row.
		const owned = await pool.query(
			"SELECT id FROM runtime.nodes WHERE id=$1 AND provider_id=$2",
			[request.nodeId, limits.providerId],
		);
		if (!owned.rowCount) throw Error("Unknown sandbox node");
		return service.transact((tx) => retireNode(tx, request.nodeId));
	}
	if (!node) throw Error("Unknown active sandbox node");
	if (request.op === "retire-template") {
		const build = (
			await pool.query(
				"SELECT * FROM runtime.template_builds WHERE id=$1 AND node_id=$2 AND provider_id=$3",
				[request.buildId, node.nodeId, limits.providerId],
			)
		).rows[0];
		if (!build || build.status === "retired")
			throw Error("Unknown or already retired template build");
		if (
			build.pve_vmid < limits.templateVmidMin ||
			build.pve_vmid > limits.templateVmidMax ||
			[590, 599, 9000, 9001].includes(build.pve_vmid)
		)
			throw Error("Template VMID is outside the configured disposable range");
		const pve = await api();
		const config = await pve.get(
			`/nodes/${node.name}/qemu/${build.pve_vmid}/config`,
		);
		if (
			Number(config.template) !== 1 ||
			!String(config.tags || "")
				.split(";")
				.includes("umiak-tpl")
		)
			throw Error("Refusing to delete an unverified template VM");
		const job = {
			nodeId: node.nodeId,
			id: `retire-${randomUUID()}`,
			slug: build.template_slug,
		};
		await service.transact(async (tx) => {
			await lockNode(tx, node.nodeId);
			const refs = await tx.client.query(
				"SELECT 1 FROM runtime.machines WHERE template_build_id=$1 AND state<>'deleted' UNION ALL SELECT 1 FROM runtime.snapshots WHERE template_build_id=$1 AND state<>'deleted' LIMIT 1",
				[build.id],
			);
			if (refs.rowCount)
				throw Error("Template still has machine or snapshot references");
			await lockNodeBuildCleanup(tx, node.nodeId, "build");
			// Nested transaction helper is intentionally avoided: admission and promotion
			// share this exact node lock through the reservation insert below.
			await tx.client.query(
				"INSERT INTO runtime.node_build_jobs(id,node_id,template_slug) VALUES($1,$2,$3)",
				[job.id, node.nodeId, build.template_slug],
			);
			await tx.client.query(
				"UPDATE runtime.template_builds SET status='deprecated' WHERE id=$1",
				[build.id],
			);
		});
		try {
			const task = await pve.delete(
				`/nodes/${node.name}/qemu/${build.pve_vmid}`,
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
			await service.transact(async (tx) => {
				await lockNode(tx, node.nodeId);
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
			await service.interrupt(job);
			throw error;
		}
	}
	if (request.op === "cleanup-build") {
		await service.transact(async (tx) => {
			await lockNode(tx, node.nodeId);
			const job = (
				await tx.client.query(
					"SELECT status,template_slug FROM runtime.node_build_jobs WHERE id=$1 AND node_id=$2",
					[request.jobId, node.nodeId],
				)
			).rows[0];
			if (job?.status !== "interrupted" || job.template_slug === "node-prepare")
				throw Error(
					"Only an interrupted template build can be cleaned up; a running runner or node preparation must finish first",
				);
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
			if (
				vms.some(
					(vm) =>
						leases.some((l) => l.vmid === vm.vmid) ||
						(((vm.vmid >= limits.vmidMin && vm.vmid <= limits.vmidMax) ||
							(vm.vmid >= limits.templateVmidMin &&
								vm.vmid <= limits.templateVmidMax)) &&
							vm.status !== "stopped"),
				)
			)
				throw Error(
					"Inspect and remove build/verification VMs before releasing the reservation",
				);
			await tx.client.query(
				"DELETE FROM runtime.vmid_leases WHERE build_job_id=$1",
				[request.jobId],
			);
			await finishNodeBuild(tx, {
				nodeId: node.nodeId,
				jobId: request.jobId,
				status: "failed",
			});
		});
		return { ok: true };
	}

	throw Error("Unknown node console operation");
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
	try {
		let raw = "";
		for await (const chunk of process.stdin) {
			raw += chunk;
			if (raw.length > 65536) throw Error("Node request too large");
		}
		console.log(JSON.stringify(await nodeCommand(pool, JSON.parse(raw))));
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	} finally {
		await pool.end();
	}
}
