import assert from "node:assert/strict";
import test from "node:test";
import { layerInventory } from "./layer-inventory.mjs";

const hash = "a".repeat(64);
function fixture() {
	return {
		sourceCommit: "b".repeat(40),
		facts: {
			packages: { bash: "1" },
			tools: { claude: null, bun: null, bunx: null, opencode: null },
		},
		files: [
			{ path: "licenses/deb/bash.copyright", sha256: hash, sizeBytes: 10 },
			{ path: "licenses/npm/example/LICENSE", sha256: hash, sizeBytes: 10 },
			{ path: `inputs/by-sha256/${hash}`, sha256: hash, sizeBytes: 10 },
		],
		packages: [
			{
				name: "bash",
				version: "1",
				source: "bash",
				sourceVersion: "1",
				notice: "licenses/deb/bash.copyright",
			},
		],
		npm: [
			{
				name: "example",
				version: "1.0.0",
				license: "MIT",
				integrity: "sha512-abc",
				url: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
				notices: ["licenses/npm/example/LICENSE"],
			},
		],
		fetches: [],
	};
}
test("inventory binds exact installed packages, dependency integrity and notice hashes", () => {
	const inventory = layerInventory(fixture());
	assert.equal(inventory.packages[0].version, "1");
	assert.equal(inventory.npm[0].noticeFiles[0].sha256, hash);
	assert.equal(inventory.sourceCommit, "b".repeat(40));
});
for (const kind of [
	"unknown-license",
	"missing-notice",
	"proprietary",
	"bun",
	"opencode",
	"package-drift",
	"missing-input",
]) {
	test(`publication inventory rejects ${kind}`, () => {
		const s = fixture();
		if (kind === "unknown-license") s.npm[0].license = "NOASSERTION";
		if (kind === "missing-notice") s.npm[0].notices = [];
		if (kind === "proprietary") s.npm[0].name = "@anthropic-ai/claude-code";
		if (kind === "bun")
			s.fetches = [
				{
					url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip",
					sha256: hash,
				},
			];
		if (kind === "opencode") s.facts.tools.opencode = "1.19.5";
		if (kind === "package-drift") s.packages[0].version = "2";
		if (kind === "missing-input")
			s.fetches = [
				{
					url: "https://go.dev/dl/go1.27.3.linux-amd64.tar.gz",
					sha256: "c".repeat(64),
				},
			];
		assert.throws(() => layerInventory(s));
	});
}
