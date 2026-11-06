// This bounded descriptor contains guest build data; it never authorizes host commands or paths.
function check(ok) {
	if (!ok) throw Error("Invalid offline layer recipe descriptor");
}
function object(v, keys) {
	check(
		v &&
			typeof v === "object" &&
			!Array.isArray(v) &&
			Object.keys(v).length === keys.length &&
			keys.every((k) => Object.hasOwn(v, k)),
	);
}
const hardware = {
	machine: ["q35"],
	cpu: ["host"],
	bios: ["seabios"],
	ostype: ["l26"],
	scsihw: ["virtio-scsi-single"],
	agent: ["enabled=1"],
	serial0: ["socket"],
	vga: ["std"],
	tablet: ["0"],
	rng0: ["source=/dev/urandom"],
};
export function parseLayerRecipe(bytes, slug) {
	check(Buffer.isBuffer(bytes) && bytes.length <= 1024 ** 2);
	const r = JSON.parse(bytes.toString("utf8"));
	check(JSON.stringify(r) === bytes.toString("utf8"));
	object(r, [
		"format",
		"slug",
		"source",
		"disk",
		"hw",
		"buildVm",
		"steps",
		"bootTimeoutS",
		"verify",
		"versions",
		"facts",
	]);
	check(
		r.format === "umiak-linux-recipe/v1" &&
			["linux", "linux-desktop"].includes(slug) &&
			r.slug === slug &&
			r.verify === slug,
	);
	object(r.source, ["kind", "distro", "release", "flavor"]);
	check(
		r.source.kind === "cloud-image" &&
			r.source.distro === "ubuntu" &&
			r.source.release === "26.04" &&
			r.source.flavor === "minimal",
	);
	object(r.disk, ["slot", "sizeGb"]);
	check(r.disk.slot === "scsi0" && r.disk.sizeGb === 64);
	object(r.hw, Object.keys(hardware));
	check(Object.entries(r.hw).every(([k, v]) => hardware[k]?.includes(v)));
	object(r.buildVm, ["cores", "memoryMb"]);
	check(
		Number.isInteger(r.buildVm.cores) &&
			r.buildVm.cores >= 1 &&
			r.buildVm.cores <= 8 &&
			Number.isInteger(r.buildVm.memoryMb) &&
			r.buildVm.memoryMb >= 2048 &&
			r.buildVm.memoryMb <= 16384,
	);
	check(
		Array.isArray(r.steps) &&
			r.steps.length <= 32 &&
			r.steps[0] === "00-base" &&
			r.steps.at(-1) === "90-cleanup" &&
			r.steps.includes("50-umiak-agent"),
	);
	const scripts = r.steps.filter((s) => s !== "reboot");
	check(
		r.steps.every((s) => s === "reboot" || /^\d{2}-[a-z0-9-]+$/.test(s)) &&
			new Set(scripts).size === scripts.length,
	);
	check(
		Number.isInteger(r.bootTimeoutS) &&
			r.bootTimeoutS >= 60 &&
			r.bootTimeoutS <= 1200,
	);
	check(
		r.versions && typeof r.versions === "object" && !Array.isArray(r.versions),
	);
	object(r.facts, ["kernel", "systemd", "packages", "tools"]);
	const text = (v) =>
		typeof v === "string" &&
		v.length > 0 &&
		v.length <= 2048 &&
		![...v].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127);
	check(text(r.facts.kernel) && text(r.facts.systemd));
	for (const [field, pattern] of [
		["packages", /^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/],
		["tools", /^[a-z0-9][a-z0-9_-]*$/],
	]) {
		const values = r.facts[field];
		check(
			values &&
				typeof values === "object" &&
				!Array.isArray(values) &&
				Object.keys(values).length <= 4096,
		);
		check(
			Object.entries(values).every(
				([k, v]) =>
					pattern.test(k) && (text(v) || (field === "tools" && v === null)),
			),
		);
	}
	return r;
}
export function layerRecipeDescriptor(recipe, versions, facts) {
	const descriptor = {
		format: "umiak-linux-recipe/v1",
		slug: recipe.slug,
		source: recipe.source,
		disk: recipe.disk,
		hw: recipe.hw,
		buildVm: recipe.buildVm,
		steps: recipe.steps,
		bootTimeoutS: recipe.bootTimeoutS,
		verify: recipe.verify,
		versions,
		facts,
	};
	const bytes = Buffer.from(JSON.stringify(descriptor));
	parseLayerRecipe(bytes, recipe.slug);
	return bytes;
}
