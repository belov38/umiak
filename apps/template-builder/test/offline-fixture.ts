import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { layerRecipeDescriptor } from "../../../infra/templates/layer-recipe.mjs";
import { layerFixture } from "../../../infra/templates/testdata/layers/fixture.mjs";
import { verifyOfflineLayer } from "../src/layer-release.ts";
import { loadRecipe, loadVersions, stepFile } from "../src/recipe.ts";
import type { ImageFacts } from "../src/seal.ts";
export function offlineFixture(baseSHA256: string, facts: ImageFacts) {
	const recipe = loadRecipe(
		resolve(import.meta.dirname, "../../../infra/templates"),
		"linux",
		"linux",
	);
	const versions = loadVersions(recipe);
	versions.base.sha256 = baseSHA256;
	const manifest = layerFixture();
	manifest.base = {
		...versions.base,
		url: `https://cloud-images.ubuntu.com/minimal/releases/resolute/release-${versions.base.serial}/ubuntu-26.04-minimal-cloudimg-amd64.img`,
	};
	manifest.aptSnapshot = versions.apt.snapshot;
	const hash = (bytes: Buffer) =>
		createHash("sha256").update(bytes).digest("hex");
	const descriptor = layerRecipeDescriptor(recipe, versions, facts),
		verifyScript = Buffer.from("fixture verify"),
		binary = Buffer.from("fixture generic binary");
	manifest.agent.sha256 = hash(binary);
	for (const [path, data] of [
		["build/layer-recipe.json", descriptor],
		["build/verify.sh", verifyScript],
		["build/generic-agent/umiak-agent", binary],
	] as const)
		manifest.files.push({
			path,
			sizeBytes: data.length,
			sha256: hash(data),
			mode: 0o644,
		});
	for (const step of recipe.steps)
		if (step !== "reboot") {
			const data = readFileSync(stepFile(recipe, step));
			manifest.files.push({
				path: `build/steps/${step}.sh`,
				sizeBytes: data.length,
				sha256: hash(data),
				mode: 0o644,
			});
		}
	manifest.archive.sizeBytes =
		manifest.files.reduce((n, f) => n + f.sizeBytes + 1024, 0) + 1024;
	const bytes = Buffer.from(JSON.stringify(manifest));
	const key = generateKeyPairSync("ed25519");
	return verifyOfflineLayer({
		bytes,
		signature: sign(null, bytes, key.privateKey),
		descriptor,
		verifyScript,
		keys: [key.publicKey.export({ type: "spki", format: "pem" }).toString()],
		platform: "0.1.0",
		agent: "0.1.0",
		channel: "stable",
		slug: "linux",
	});
}
