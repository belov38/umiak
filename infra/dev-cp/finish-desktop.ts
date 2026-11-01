// Recover only S10's already-sealed template after the host slot whitelist was extended.
import {
	makeContext,
	registryDir,
} from "../../apps/template-builder/src/context.ts";
import { FileRegistry } from "../../apps/template-builder/src/registry.ts";

const registry = new FileRegistry(registryDir());
const m = registry.get(process.argv[2] ?? "");
if (
	m?.templateSlug !== "linux-desktop" ||
	m.error?.stage !== "template" ||
	![595, 596].includes(m.pveVmid ?? 0)
)
	throw new Error("expected failed desktop template finalization");
const ctx = await makeContext({ node: m.node });
try {
	const vmid = m.pveVmid as number;
	const config = await ctx.api.get<{
		template: number;
		name: string;
		tags: string;
	}>(`/nodes/${m.node}/qemu/${vmid}/config`);
	if (
		Number(config.template) !== 1 ||
		config.name !== m.vmName ||
		!config.tags.split(";").includes("sbx-tpl")
	)
		throw new Error("not the expected sealed template");
	await ctx.node.call("lv.tagTemplate", { vmid });
	const usage = await ctx.node.call<{ sizeBytes: number; dataPercent: number }>(
		"lv.usage",
		{ name: `base-${vmid}-disk-0` },
	);
	if (usage.dataPercent > 40) throw new Error("template thin disk not trimmed");
	await ctx.allocator.markActive(vmid);
	const diskUsedGiB =
		Math.round(((usage.sizeBytes * usage.dataPercent) / 100 / 2 ** 30) * 10) /
		10;
	registry.update(m.buildId, { status: "ready", diskUsedGiB }, ["error"]);
	console.log(
		`template ${vmid} ready; disk ${diskUsedGiB} GiB; verify pending`,
	);
} finally {
	ctx.close();
}
