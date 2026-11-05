// Manual release tooling. Never includes signing keys in the recipe archive.
import { execFileSync } from "node:child_process";
import { createHash, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const version = process.env.RECIPE_VERSION;
if (!/^\d{8}\.\d+(?:-edge\.\d{8}\.\d+)?$/.test(version || ""))
	throw Error("Recipe version must be YYYYMMDD.N");
const out = resolve(process.env.RECIPE_OUTPUT || "dist/recipes");
const temp = await mkdtemp(join(tmpdir(), "umiak-recipes-"));
try {
	await mkdir(out, { recursive: true });
	await mkdir(join(temp, "infra"));
	await cp("infra/templates", join(temp, "infra/templates"), {
		recursive: true,
	});
	const channelSuffix = version.includes("-edge.") ? "-edge." : null;
	const tags = execFileSync("git", ["tag", "--list", "recipes-*"], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter((t) =>
			channelSuffix ? t.includes(channelSuffix) : !t.includes("-edge."),
		)
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
	const diffBase = process.env.RECIPE_DIFF_BASE || tags[0] || "HEAD^";
	const diff = execFileSync(
		"git",
		["diff", diffBase, "HEAD", "--", "infra/templates/**/versions.toml"],
		{ encoding: "utf8" },
	);
	const manifest = {
		version,
		builderApi: 1,
		minPlatform: process.env.MIN_PLATFORM || "0.1.0",
		maxPlatform: process.env.MAX_PLATFORM || "0.2.0",
		minAgent: process.env.MIN_AGENT || "0.1.0",
		changelog: `${process.env.RECIPE_CHANGELOG || "Recipe refresh"}\n\n${diff}`,
	};
	await writeFile(
		join(temp, "channel.json"),
		JSON.stringify(manifest, null, 2),
	);
	execFileSync("tar", [
		"--format=ustar",
		"-cf",
		join(out, "recipes.tar"),
		"-C",
		temp,
		"channel.json",
		"infra/templates",
	]);
	const sums = Buffer.from(
		`${createHash("sha256")
			.update(await readFile(join(out, "recipes.tar")))
			.digest("hex")}  recipes.tar\n`,
	);
	await writeFile(join(out, "SHA256SUMS"), sums);
	await writeFile(
		join(out, "SHA256SUMS.sig"),
		sign(null, sums, await readFile(process.env.RECIPE_SIGNING_KEY_FILE)),
	);
	await writeFile(join(out, "CHANGELOG.md"), manifest.changelog);
} finally {
	await rm(temp, { recursive: true, force: true });
}
