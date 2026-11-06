import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AptPackage, verifyAptIndex } from "./offline-apt.ts";
import { captureAptRepository } from "./offline-apt-capture.ts";

const authorities: Record<string, string> = {
	ubuntu: "f6ecb3762474eda9d21b7022871920d1991bc93c",
	docker: "9dc858229fc7dd38854ae2d88d81803c0ebfcd88",
	xtradeb: "5301fa4fd93244fbc6f6149982bb6851c64f6880",
};
interface CapturedRepo {
	name: string;
	suite: string;
	components: string[];
	keyFingerprint: string;
	indexes: string[];
}
interface CapturedDeb {
	path: string;
	sha256: string;
	sizeBytes: number;
}
interface AptExport {
	repositories: CapturedRepo[];
	debs: CapturedDeb[];
}
/** Converts guest capture evidence into separately authenticated, original apt mirrors. */
export async function materializeCapturedApt(o: {
	rawDirectory: string;
	layerDirectory: string;
	directDebs: Set<string>;
}): Promise<AptPackage[]> {
	const base = join(o.rawDirectory, "inputs/apt-capture");
	const data = await readFile(join(base, "capture.json"));
	if (data.length > 1024 ** 2) throw Error("Apt capture metadata too large");
	const capture = JSON.parse(data.toString()) as AptExport;
	if (
		!Array.isArray(capture.repositories) ||
		capture.repositories.length === 0 ||
		capture.repositories.length > 16 ||
		!Array.isArray(capture.debs) ||
		capture.debs.length > 4096
	)
		throw Error("Invalid apt capture metadata");
	const available = new Map<string, string>();
	const prepared = [];
	const names = new Set<string>();
	for (const r of capture.repositories) {
		const family =
			/^(ubuntu|docker|xtradeb)-resolute(?:-updates|-security|-backports)?$/.exec(
				r.name,
			)?.[1];
		if (
			!family ||
			names.has(r.name) ||
			r.name !== `${family}-${r.suite}` ||
			r.keyFingerprint?.toLowerCase() !== authorities[family] ||
			!Array.isArray(r.indexes) ||
			r.indexes.length === 0 ||
			r.indexes.length > 16
		)
			throw Error("Unapproved apt capture authority/suite");
		names.add(r.name);
		const root = join(base, r.name);
		const inRelease = await readFile(join(root, "InRelease"), "utf8");
		const publicKey = await readFile(join(root, "archive.asc"), "utf8");
		const indexes = [];
		for (const path of r.indexes) {
			if (!/^[a-z][a-z0-9-]*\/binary-amd64\/Packages$/.test(path))
				throw Error("Unsafe apt capture index");
			const index = await readFile(join(root, path));
			if (index.length > 256 * 1024 ** 2)
				throw Error("Apt capture index too large");
			const packages = await verifyAptIndex({
				inRelease,
				publicKey,
				keyFingerprint: r.keyFingerprint,
				indexPath: path,
				index,
				expectedSuite: r.suite,
			});
			for (const pkg of packages)
				if (!available.has(pkg.sha256)) available.set(pkg.sha256, r.name);
			indexes.push({ path, bytes: index });
		}
		prepared.push({
			repository: {
				name: r.name,
				suite: r.suite,
				components: r.components,
				keyring: `/mnt/layer/apt/${r.name}/archive.asc`,
			},
			publicKey,
			keyFingerprint: r.keyFingerprint,
			inRelease,
			indexes,
		});
	}
	const debs = new Map<string, { path: string; sha256: string }[]>();
	const seen = new Set<string>();
	for (const deb of capture.debs) {
		if (
			!/^[a-f0-9]{64}$/.test(deb.sha256) ||
			seen.has(deb.sha256) ||
			deb.path !== `inputs/apt-capture/debs/${deb.sha256}.deb`
		)
			throw Error("Invalid captured deb identity");
		seen.add(deb.sha256);
		const repository = available.get(deb.sha256);
		if (!repository) {
			if (o.directDebs.has(deb.sha256)) continue;
			throw Error("Captured deb absent from approved signed apt indexes");
		}
		const list = debs.get(repository) ?? [];
		list.push({ path: join(o.rawDirectory, deb.path), sha256: deb.sha256 });
		debs.set(repository, list);
	}
	const packages: AptPackage[] = [];
	const sources = [];
	await mkdir(join(o.layerDirectory, "apt"), { recursive: true });
	for (const p of prepared) {
		const selected = debs.get(p.repository.name);
		if (!selected?.length) continue;
		const result = await captureAptRepository({
			...p,
			directory: join(o.layerDirectory, "apt"),
			debs: selected,
		});
		packages.push(...result.packages);
		sources.push(result.sources);
	}
	if (!packages.some((p) => p.name === "qemu-guest-agent"))
		throw Error("Offline layer omits QGA bootstrap dependency");
	await writeFile(
		join(o.layerDirectory, "apt/offline.sources"),
		sources.join("\n"),
		{ flag: "wx" },
	);
	return packages;
}
