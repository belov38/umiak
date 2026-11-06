import { retireNodeTemplate } from "./node-template-retirement.mjs";
import { idleForRecipeBuild, RecipeChannel } from "./recipe-channel.mjs";
export function recipeRollout({
	jobs,
	store,
	nodes,
	query,
	pool,
	pveOf,
	connectionOf,
	nodeCheck,
	secretsDir,
}) {
	const channel = new RecipeChannel({
		jobs,
		secretsDir,
		rollout: async (release, state) => {
			if (!state.steps?.limits?.data?.providerId) return;
			const inventory = await nodes.list(state.steps.limits.data.providerId);
			const old = (
				await query(
					"SELECT * FROM runtime.template_builds b WHERE status='deprecated' AND promoted_at < now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM runtime.machines m WHERE m.template_build_id=b.id AND m.state<>'deleted') AND NOT EXISTS(SELECT 1 FROM runtime.snapshots s WHERE s.template_build_id=b.id AND s.state<>'deleted')",
				)
			).rows;
			for (const build of old) {
				const busy = (
					await query(
						"SELECT 1 FROM runtime.machines WHERE node_id=$1 AND state NOT IN ('deleted','stopped') LIMIT 1",
						[build.node_id],
					)
				).rowCount;
				if (busy) continue;
				const node = inventory.find((n) => n.nodeId === build.node_id);
				if (!node || !idleForRecipeBuild(node)) continue;
				await retireNodeTemplate({
					requireDeprecated: true,
					pool,
					service: nodes,
					node,
					build,
					limits: state.steps.limits.data,
					pve: await pveOf(state),
					probeLocal: (op) =>
						nodeCheck(
							{
								...connectionOf(state),
								node: node.name,
								sshHost: node.sshHost,
							},
							secretsDir,
							op,
						),
				});
			}
			const builds = (
				await query(
					"SELECT * FROM runtime.template_builds WHERE status='active' ORDER BY created_at DESC",
				)
			).rows;
			for (const slug of [...new Set(builds.map((b) => b.template_slug))]) {
				// Signed Linux layers are rolled manually in the first S25 release; recipe
				// updates must never rebuild them repeatedly or replace them with local builds.
				if (
					slug.startsWith("linux") &&
					builds.some(
						(b) => b.template_slug === slug && b.manifest?.offlineLayer,
					)
				)
					continue;
				if (
					builds
						.filter((b) => b.template_slug === slug)
						.every((b) => b.manifest?.recipeVersion === release.version)
				)
					continue;
				for (const node of inventory.filter(idleForRecipeBuild)) {
					const selected = await nodes.select(state, node.nodeId),
						limits = selected.steps.limits.data;
					const vms = await (await pveOf(selected)).get(
						`/nodes/${connectionOf(selected).node}/qemu`,
					);
					if (
						vms.some(
							(v) =>
								v.vmid >= limits.vmidMin &&
								v.vmid <= limits.vmidMax &&
								v.status !== "stopped",
						)
					)
						continue;
					const input = {
						nodeId: node.nodeId,
						confirmRebuild: slug,
						...(slug.startsWith("linux") ? { buildMode: "local" } : {}),
					};
					if (slug === "windows") {
						const previous = builds.find(
							(b) => b.template_slug === slug,
						)?.manifest;
						if (!previous?.iso || !previous.isoSha256)
							throw Error(
								"Windows rollout needs recorded ISO name and checksum; Rebuild now with verified media",
							);
						Object.assign(input, {
							iso: previous.iso,
							isoSha256: previous.isoSha256,
							virtioIso: previous.virtioIso,
							virtioSha256: previous.virtioSha256,
						});
					}
					// The deployed public URL is persisted by network bootstrap.
					const origin =
						state.bootstrap?.publicUrl || process.env.UMIAK_PUBLIC_URL;
					if (!origin)
						throw Error(
							"Configure UMIAK_PUBLIC_URL for autonomous template rollout",
						);
					await channel.update((c) => {
						c.progress = `Building ${slug} on ${node.name}`;
					});
					await jobs.start(slug, input, { origin });
					await jobs.settled();
					const job = (await store.read()).buildJob;
					await channel.update((c) => {
						c.history = [
							{
								version: release.version,
								slug,
								nodeId: node.nodeId,
								status: job.status,
								error: job.error,
								at: new Date().toISOString(),
							},
							...(c.history || []),
						].slice(0, 100);
						c.progress = job.status;
					});
					if (job.status !== "ready")
						throw Error(
							job.error || "Rollout failed; Retry after checking build details",
						);
					return;
				}
				await channel.update((c) => {
					c.progress = "Waiting for an idle node";
				});
				return;
			}
			await channel.update((c) => {
				c.progress = "Up to date";
			});
		},
	});
	return channel;
}
