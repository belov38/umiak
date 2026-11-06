import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { layerRecipeDescriptor } from "../../../infra/templates/layer-recipe.mjs";
import { layerFixture } from "../../../infra/templates/testdata/layers/fixture.mjs";
import { verifyOfflineLayer } from "../src/layer-release.ts";
import { loadRecipe, loadVersions } from "../src/recipe.ts";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
it("binds every small control artifact to the publisher-signed layer before provisioning", () => {
	const recipe = loadRecipe(
		resolve(import.meta.dirname, "../../../infra/templates"),
		"linux",
		"linux",
	);
	const versions = loadVersions(recipe);
	const facts = {
		kernel: "fixture",
		systemd: "systemd259",
		packages: { bash: "5.3" },
		tools: { claude: null },
	};
	const descriptor = layerRecipeDescriptor(recipe, versions, facts);
	const verify = Buffer.from("echo fixture");
	const binary = Buffer.from("agent fixture");
	const manifest = layerFixture();
	manifest.base = {
		...manifest.base,
		...versions.base,
		url: `https://cloud-images.ubuntu.com/minimal/releases/resolute/release-${versions.base.serial}/ubuntu-26.04-minimal-cloudimg-amd64.img`,
	};
	manifest.aptSnapshot = versions.apt.snapshot;
	manifest.agent.sha256 = sha(binary);
	for (const [path, bytes] of [
		["build/layer-recipe.json", descriptor],
		["build/verify.sh", verify],
		["build/generic-agent/umiak-agent", binary],
	] as const)
		manifest.files.push({
			path,
			sizeBytes: bytes.length,
			sha256: sha(bytes),
			mode: 0o644,
		});
	for (const step of recipe.steps)
		if (step !== "reboot")
			manifest.files.push({
				path: `build/steps/${step}.sh`,
				sizeBytes: verify.length,
				sha256: sha(verify),
				mode: 0o644,
			});
	const bytes = Buffer.from(JSON.stringify(manifest));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const input = {
		bytes,
		signature: sign(null, bytes, privateKey),
		descriptor,
		verifyScript: verify,
		keys: [publicKey.export({ type: "spki", format: "pem" }).toString()],
		platform: "0.1.0",
		agent: "0.1.0",
		channel: "stable",
		slug: "linux",
	};
	expect(verifyOfflineLayer(input).descriptor.facts).toEqual(facts);
	expect(() =>
		verifyOfflineLayer({ ...input, verifyScript: Buffer.from("tampered") }),
	).toThrow();
	expect(() =>
		verifyOfflineLayer({ ...input, descriptor: Buffer.from("{}") }),
	).toThrow();
	expect(() => verifyOfflineLayer({ ...input, channel: "edge" })).toThrow();
});
