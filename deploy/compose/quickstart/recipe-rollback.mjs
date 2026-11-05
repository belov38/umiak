// The node lock in promote fences retirement, builds and sandbox placement.
export async function rollbackRecipe({
	build,
	nodes,
	state,
	pveOf,
	connectionOf,
	nodeCheck,
	secretsDir,
}) {
	if (build?.status !== "deprecated" || !build.manifest?.verify?.ok)
		throw Error("No verified previous build");
	const selected = await nodes.select(state, build.node_id);
	const connection = connectionOf(selected);
	const config = await (await pveOf(selected)).get(
		`/nodes/${connection.node}/qemu/${build.pve_vmid}/config`,
	);
	if (Number(config.template) !== 1)
		throw Error("Previous template unavailable");
	const local = await nodeCheck(connection, secretsDir, {
		op: "lv.list",
		args: {},
	});
	const disks = Object.entries(config)
		.filter(([slot]) => /^(scsi\d+|efidisk0|tpmstate0)$/.test(slot))
		.map(([, value]) => String(value).split(",")[0].split(":").pop());
	if (
		!disks.length ||
		disks.some((d) => !local.lvs?.some((lv) => lv.name === d))
	)
		throw Error("Previous template disks unavailable");
	await nodes.promote({ nodeId: build.node_id, buildId: build.id });
}
