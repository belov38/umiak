// Publisher authority is provisioned independently of downloaded release assets.
import { createHash, verify } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTar } from "../../../apps/template-builder/src/tar.ts";
export const BUILDER_API = 1;
export function compareVersion(a, b) {
	const parse = (v) => {
		if (!/^\d+\.\d+\.\d+(?:-edge\.\d{8}\.\d+)?(?:\+[\w.-]+)?$/.test(v || ""))
			throw Error("Expected stable semantic version");
		return v.split("+")[0].split("-edge.")[0].split(".").map(Number);
	};
	const x = parse(a),
		y = parse(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
	return 0;
}
export function verifyRecipeBundle({
	archive,
	sums,
	signature,
	keys,
	platform,
	agent,
}) {
	if (
		!keys.length ||
		!keys.some((key) => {
			try {
				return verify(null, sums, key, signature);
			} catch {
				return false;
			}
		})
	)
		throw Error("Recipe signature verification failed");
	const digest = createHash("sha256").update(archive).digest("hex");
	if (sums.toString() !== `${digest}  recipes.tar\n`)
		throw Error("Recipe checksum verification failed");
	const files = readTar(archive, 4096);
	for (const name of files.keys())
		if (
			name !== "channel.json" &&
			!/^infra\/templates\/[A-Za-z0-9_./@+-]+$/.test(name)
		)
			throw Error("Unexpected recipe archive path");
	const manifest = JSON.parse(files.get("channel.json")?.toString() || "null");
	if (
		!manifest ||
		!/^\d{8}\.\d+(?:-edge\.\d{8}\.\d+)?$/.test(manifest.version) ||
		typeof manifest.changelog !== "string"
	)
		throw Error("Invalid recipe manifest");
	if (
		manifest.builderApi !== BUILDER_API ||
		compareVersion(platform, manifest.minPlatform) < 0 ||
		compareVersion(platform, manifest.maxPlatform) >= 0 ||
		compareVersion(agent, manifest.minAgent) < 0
	)
		throw Error("Recipe incompatible with this platform, agent or builder");
	for (const slug of ["linux", "debian", "linux-desktop", "windows"])
		if (!files.has(`infra/templates/${slug}/template.yaml`))
			throw Error("Incomplete recipe bundle");
	return { manifest, files, digest };
}
export async function cacheRecipeBundle(verified, root) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(root, ".incoming-"));
	try {
		for (const [name, data] of verified.files) {
			const path = join(directory, name);
			await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
			await writeFile(path, data, { mode: 0o600 });
		}
		const destination = join(
			root,
			`${verified.manifest.version}-${verified.digest}`,
		);
		try {
			await rename(directory, destination);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
		}
		return join(destination, "infra/templates");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
