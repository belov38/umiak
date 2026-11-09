// Console-only installer bridge. No HTTP endpoint and no host shell credentials.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
	beginNodeBuild,
	ensureQueues,
	finishNodeBuild,
	lockNode,
	nodeRemovalPlan,
	PgBossJobSender,
	registerSandboxNode,
	requestNodePurge,
	retireNode,
} from "../../../packages/core/src/index.ts";
import pg from "../../../packages/db/node_modules/pg/lib/index.js";
import { retireNodeTemplate } from "./node-template-retirement.mjs";
import { PgSetupStore } from "./setup.mjs";
import { cleanupBuild } from "./setup-build-cleanup.mjs";
import { checkNode, pinnedPve } from "./setup-host.mjs";
import { nodeService } from "./setup-nodes.mjs";
import { replicateActiveTemplates } from "./template-replication.mjs";

/** Send-only pg-boss, as the API uses it: the worker supervises and works the queues. */
async function bossJobs(pool) {
	const { PgBoss } = await import(
		"../../../packages/core/node_modules/pg-boss/dist/index.js"
	);
	const boss = new PgBoss({
		db: { executeSql: (text, values) => pool.query(text, values) },
		schema: "pgboss",
		supervise: false,
		schedule: false,
		registerInstance: false,
	});
	boss.on("error", (error) => console.error(`pg-boss: ${error.message}`));
	await boss.start();
	await ensureQueues(boss);
	return {
		jobs: new PgBossJobSender(boss),
		stop: () => boss.stop({ graceful: false }),
	};
}

export async function nodeCommand(
	pool,
	request,
	{
		secretsDir = process.env.UMIAK_SECRETS_DIR || "/pve-secrets",
		probe = checkNode,
		makePve = pinnedPve,
		makeJobs = bossJobs,
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
				"SELECT to_regclass('runtime.node_build_jobs') IS NOT NULL AND (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='runtime' AND table_name='nodes' AND column_name IN ('retired_at','media_storage')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='runtime' AND table_name='vmid_leases' AND column_name='build_job_id') AND (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='runtime' AND table_name='node_build_jobs' AND column_name IN ('retiring_build_id','pve_task_upid','pve_delete_requested_at')) AS ready",
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
			jobs: (
				await pool.query(
					"SELECT b.id,b.node_id,b.status,b.template_slug,b.retiring_build_id,b.pve_task_upid,b.pve_delete_requested_at,b.created_at FROM runtime.node_build_jobs b JOIN runtime.nodes n ON n.id=b.node_id WHERE n.provider_id=$1 ORDER BY b.created_at",
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
							"SELECT s.id AS storage_id,n.node_agent_ref,n.ram_cap_mb,n.media_storage,s.name AS storage FROM runtime.nodes n JOIN runtime.storages s ON s.node_id=n.id AND s.driver='lvmthin' WHERE n.id=$1",
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
		const registered = await service.transact(async (tx) => {
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
					"SELECT id,status FROM runtime.node_build_jobs WHERE id=$1 AND node_id=$2 AND template_slug='node-prepare' AND status IN ('running','interrupted','succeeded')",
					[request.preparationId, existing.id],
				)
			).rows[0];
			if (!job) throw Error("Missing matching node preparation reservation");
			const staged = (
				await tx.client.query(
					"SELECT s.id AS storage_id,n.node_agent_ref,n.ram_cap_mb,n.media_storage,s.name AS storage FROM runtime.nodes n JOIN runtime.storages s ON s.node_id=n.id AND s.driver='lvmthin' WHERE n.id=$1",
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
			if (job.status === "succeeded")
				return { ok: true, nodeId: existing.id, storageId: staged.storage_id };
			if (job.status !== "succeeded")
				await finishNodeBuild(tx, {
					nodeId: existing.id,
					jobId: job.id,
					status: "succeeded",
				});
			return { ok: true, ...(await registerSandboxNode(tx, cfg)) };
		});
		await replicateActiveTemplates({
			pool,
			state,
			targetNodeId: registered.nodeId,
			api: await api(),
			nodeCheck: probe,
			secretsDir,
		});
		return registered;
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
	if (request.op === "removal-plan") {
		// Also answers for an already retired node: a retry after host cleanup failed.
		const owned = await pool.query(
			"SELECT id FROM runtime.nodes WHERE id=$1 AND provider_id=$2",
			[request.nodeId, limits.providerId],
		);
		if (!owned.rowCount) throw Error("Unknown sandbox node");
		return nodeRemovalPlan(pool, request.nodeId);
	}
	if (!node) throw Error("Unknown active sandbox node");
	if (request.op === "purge") {
		// The IDs the operator confirmed; anything else live on the node refuses.
		const confirmed = request.confirmed;
		if (
			!Array.isArray(confirmed) ||
			!confirmed.every((id) => typeof id === "string")
		)
			throw Error(
				"purge needs the confirmed sandbox, machine and snapshot IDs",
			);
		const boss = await makeJobs(pool);
		try {
			return await requestNodePurge(pool, boss.jobs, node.nodeId, confirmed);
		} finally {
			await boss.stop?.();
		}
	}
	if (request.op === "retire-template") {
		const build = (
			await pool.query(
				"SELECT * FROM runtime.template_builds WHERE id=$1 AND node_id=$2 AND provider_id=$3",
				[request.buildId, node.nodeId, limits.providerId],
			)
		).rows[0];
		if (!build) throw Error("Unknown template build");
		if (
			build.pve_vmid < limits.templateVmidMin ||
			build.pve_vmid > limits.templateVmidMax
		)
			throw Error("Template VMID is outside the configured disposable range");
		return retireNodeTemplate({
			pool,
			service,
			node,
			build,
			limits,
			pve: await api(),
			taskUpid: request.taskUpid,
			probeLocal: (operation) =>
				probe(
					{
						...state.steps.connection.data,
						node: node.name,
						sshHost: node.sshHost,
					},
					secretsDir,
					operation,
				),
		});
	}

	if (request.op === "cleanup-build") {
		return cleanupBuild({
			service,
			node,
			request,
			state,
			limits,
			api,
			probe,
			secretsDir,
		});
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
