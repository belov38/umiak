import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
	type AptPackage,
	type OfflineRepository,
	offlineAptSources,
	verifyAptIndex,
} from "./offline-apt.ts";

export interface AptCaptureInput {
	directory: string;
	repository: OfflineRepository;
	publicKey: string;
	keyFingerprint: string;
	inRelease: string;
	indexes: { path: string; bytes: Buffer }[];
	debs: { path: string; sha256: string }[];
}
/** Materialize an upstream-signed subset, retaining each original index unchanged. */
export async function captureAptRepository(
	o: AptCaptureInput,
): Promise<{ packages: AptPackage[]; sources: string }> {
	const sources = offlineAptSources([o.repository]);
	if (
		o.indexes.length === 0 ||
		o.indexes.length > 32 ||
		o.debs.length === 0 ||
		o.debs.length > 4096
	)
		throw Error("Invalid apt capture input count");
	const seen = new Set<string>();
	const byHash = new Map<string, AptPackage>();
	for (const index of o.indexes) {
		if (seen.has(index.path)) throw Error("Duplicate apt index");
		seen.add(index.path);
		if (
			index.bytes.length > 256 * 1024 ** 2 ||
			!o.repository.components.some(
				(c) => index.path === `${c}/binary-amd64/Packages`,
			)
		)
			throw Error("Unexpected apt component/index");
		const packages = await verifyAptIndex({
			...o,
			indexPath: index.path,
			index: index.bytes,
			expectedSuite: o.repository.suite,
		});
		for (const pkg of packages) {
			const prior = byHash.get(pkg.sha256);
			if (
				prior &&
				(prior.filename !== pkg.filename ||
					prior.sizeBytes !== pkg.sizeBytes ||
					prior.version !== pkg.version ||
					prior.name !== pkg.name)
			)
				throw Error("Conflicting apt package hash");
			byHash.set(pkg.sha256, pkg);
		}
	}
	const selected: AptPackage[] = [];
	const hashes = new Set<string>();
	for (const deb of o.debs) {
		if (hashes.has(deb.sha256)) throw Error("Duplicate captured package");
		hashes.add(deb.sha256);
		const pkg = byHash.get(deb.sha256);
		if (!pkg) throw Error("Captured deb is absent from signed Packages");
		const info = await stat(deb.path);
		if (!info.isFile() || info.size !== pkg.sizeBytes)
			throw Error("Captured deb size mismatch");
		selected.push(pkg);
	}
	// Do not merge with stale captures: a failed capture must be discarded by its job owner.
	const root = join(o.directory, o.repository.name);
	await mkdir(o.directory, { recursive: true });
	await mkdir(root);
	for (let i = 0; i < o.debs.length; i++) {
		const deb = o.debs[i];
		const pkg = selected[i];
		if (!deb || !pkg) throw Error("Missing captured deb");
		const destination = join(root, pkg.filename);
		await mkdir(dirname(destination), { recursive: true });
		const hash = createHash("sha256");
		let size = 0;
		const source = createReadStream(deb.path);
		source.on("data", (chunk) => {
			hash.update(chunk);
			size += chunk.length;
		});
		const temporary = `${destination}.part`;
		try {
			await pipeline(
				source,
				createWriteStream(temporary, { flags: "wx", mode: 0o644 }),
			);
			if (size !== pkg.sizeBytes || hash.digest("hex") !== pkg.sha256)
				throw Error("Captured deb checksum mismatch");
			await rename(temporary, destination);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}
	const dists = join(root, "dists", o.repository.suite);
	await mkdir(dists, { recursive: true });
	await writeFile(join(dists, "InRelease"), o.inRelease, { flag: "wx" });
	await writeFile(join(root, "archive.asc"), o.publicKey, { flag: "wx" });
	for (const index of o.indexes) {
		const path = join(dists, index.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, index.bytes, { flag: "wx" });
	}
	return { packages: selected, sources };
}
