import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLayerRecipe } from "./layer-recipe.mjs";

const recipe = {
	format: "umiak-linux-recipe/v1",
	slug: "linux",
	source: {
		kind: "cloud-image",
		distro: "ubuntu",
		release: "26.04",
		flavor: "minimal",
	},
	disk: { slot: "scsi0", sizeGb: 64 },
	hw: {
		machine: "q35",
		cpu: "host",
		bios: "seabios",
		ostype: "l26",
		scsihw: "virtio-scsi-single",
		agent: "enabled=1",
		serial0: "socket",
		vga: "std",
		tablet: "0",
		rng0: "source=/dev/urandom",
	},
	buildVm: { cores: 4, memoryMb: 4096 },
	steps: ["00-base", "reboot", "50-umiak-agent", "90-cleanup"],
	bootTimeoutS: 300,
	verify: "linux",
	versions: {
		base: { serial: "20261024", sha256: "a".repeat(64) },
		apt: { snapshot: "20261106T000000Z" },
	},
	facts: {
		kernel: "6.20",
		systemd: "systemd259",
		packages: { bash: "5.3" },
		tools: { claude: null },
	},
};
test("a signed layer descriptor carries recipe facts without CI paths, VMIDs or install configuration", () => {
	assert.equal(
		parseLayerRecipe(Buffer.from(JSON.stringify(recipe)), "linux").disk.sizeGb,
		64,
	);
	for (const patch of [
		{ hw: { ...recipe.hw, args: "-device host" } },
		{ slug: "windows" },
		{ steps: ["../run"] },
		{ disk: { slot: "scsi2", sizeGb: 64 } },
		{ installUrl: "https://private.invalid" },
		{ buildVm: { cores: 200, memoryMb: 1024 } },
		{ facts: { ...recipe.facts, packages: { "../bad": "1" } } },
	]) {
		assert.throws(() =>
			parseLayerRecipe(
				Buffer.from(JSON.stringify({ ...recipe, ...patch })),
				"linux",
			),
		);
	}
});
