// New builds use a separate configurable range; adoption never moves existing VMs.
export function templateRange(state) {
	const limits = state.steps?.limits?.data || {};
	const adopted = (state.steps?.templates?.data?.builds || [])
		.map((x) => Number(x.pveVmid))
		.filter(Number.isInteger);
	return {
		templateVmidMin:
			limits.templateVmidMin ?? (adopted.length ? Math.min(...adopted) : 600),
		templateVmidMax:
			limits.templateVmidMax ?? (adopted.length ? Math.max(...adopted) : 699),
	};
}
export function validateTemplateRange(limits) {
	const {
		templateVmidMin: min,
		templateVmidMax: max,
		vmidMin,
		vmidMax,
	} = limits;
	if (
		!Number.isInteger(min) ||
		!Number.isInteger(max) ||
		min < 100 ||
		max > 999999999 ||
		min > max
	)
		throw new Error(
			"Template VMID range must contain integers from 100 to 999999999",
		);
	if (min <= vmidMax && vmidMin <= max)
		throw new Error("Template VMID range must not overlap the sandbox range");
	return { templateVmidMin: min, templateVmidMax: max };
}
export function validateTemplateInventory(limits, resources) {
	const range = validateTemplateRange(limits);
	const occupiedTemplateVmids = [
		...new Set(
			resources
				.map((x) => Number(x.vmid))
				.filter(
					(id) => id >= range.templateVmidMin && id <= range.templateVmidMax,
				),
		),
	].sort((a, b) => a - b);
	return {
		occupiedTemplateVmids,
		freeTemplateVmids:
			range.templateVmidMax -
			range.templateVmidMin +
			1 -
			occupiedTemplateVmids.length,
	};
}
export async function allocateTemplateVmid(api, limits) {
	validateTemplateRange(limits);
	const resources = await api.get("/cluster/resources");
	const suggested = Number(await api.get("/cluster/nextid"));
	const occupied = new Set(resources.map((x) => Number(x.vmid)));
	if (
		Number.isInteger(suggested) &&
		suggested >= limits.templateVmidMin &&
		suggested <= limits.templateVmidMax &&
		!occupied.has(suggested)
	)
		return suggested;
	for (let id = limits.templateVmidMin; id <= limits.templateVmidMax; id++)
		if (!occupied.has(id)) return id;
	throw new Error(
		"No free template VMID in the configured range; expand the range without moving existing builds",
	);
}
