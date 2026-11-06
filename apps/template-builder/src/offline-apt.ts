import { createHash } from "node:crypto";
import * as openpgp from "openpgp";

export interface AptPackage {
	name: string;
	version: string;
	arch: string;
	filename: string;
	sizeBytes: number;
	sha256: string;
	source: string;
}
/** Parse upstream deb822 without losing duplicate fields or folded values. */
function records(text: string): Map<string, string>[] {
	const result: Map<string, string>[] = [];
	let record = new Map<string, string>(),
		previous = "";
	for (const line of text.split(/\r?\n/)) {
		if (line === "") {
			if (record.size) result.push(record);
			record = new Map();
			previous = "";
			continue;
		}
		if (line.startsWith(" ") || line.startsWith("\t")) {
			if (!previous) throw Error("Orphan deb822 continuation");
			record.set(previous, `${record.get(previous)}\n${line.trimStart()}`);
			continue;
		}
		const match = /^([A-Za-z0-9][-A-Za-z0-9]*): ?(.*)$/.exec(line);
		if (!match) throw Error("Invalid deb822 record");
		const key = (match[1] ?? "").toLowerCase();
		if (record.has(key)) throw Error("Duplicate deb822 field");
		record.set(key, match[2] ?? "");
		previous = key;
	}
	if (record.size) result.push(record);
	return result;
}
function safeRelative(path: string): boolean {
	return (
		/^[A-Za-z0-9_+.,=~:/-]+$/.test(path) &&
		!path.startsWith("/") &&
		path.split("/").every((p) => p !== "" && p !== "." && p !== "..")
	);
}
export function parseAptPackages(text: string): AptPackage[] {
	return records(text).map((r) => {
		const filename = r.get("filename") ?? "",
			size = Number(r.get("size")),
			sha256 = r.get("sha256") ?? "",
			name = r.get("package") ?? "",
			version = r.get("version") ?? "",
			arch = r.get("architecture") ?? "";
		if (
			!/^((pool\/)|(dists\/[a-z0-9-]+\/pool\/))/.test(filename) ||
			!filename.endsWith(".deb") ||
			!safeRelative(filename) ||
			!Number.isSafeInteger(size) ||
			size <= 0 ||
			size > 4 * 1024 ** 3 ||
			!/^[a-f0-9]{64}$/.test(sha256) ||
			!/^[a-z0-9][a-z0-9+.-]+$/.test(name) ||
			!version ||
			!["amd64", "all"].includes(arch)
		)
			throw Error("Invalid apt package provenance");
		return {
			name,
			version,
			arch,
			filename,
			sizeBytes: size,
			sha256,
			source: r.get("source") ?? name,
		};
	});
}
/** Authenticate original, unmodified upstream metadata; no regenerated indexes/trusted=yes. */
export interface AptIndexInput {
	inRelease: string;
	publicKey: string;
	keyFingerprint: string;
	indexPath: string;
	index: Buffer;
	expectedSuite?: string;
}
export async function verifyAptMetadata(o: AptIndexInput): Promise<void> {
	if (
		(o.publicKey.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----/g) ?? [])
			.length !== 1
	)
		throw Error("Apt keyring must hold exactly one pinned authority");
	const keys = await openpgp.readKeys({ armoredKeys: o.publicKey });
	const key = keys[0];
	if (keys.length !== 1 || !key)
		throw Error("Apt keyring must hold exactly one pinned authority");
	if (key.getFingerprint() !== o.keyFingerprint.toLowerCase())
		throw Error("Apt archive key fingerprint mismatch");
	const message = await openpgp.readCleartextMessage({
		cleartextMessage: o.inRelease,
	});
	const verified = await openpgp.verify({ message, verificationKeys: key });
	if (verified.signatures.length === 0)
		throw Error("Apt Release has no signature");
	for (const signature of verified.signatures) await signature.verified;
	const release = records(String(verified.data));
	if (
		release.length !== 1 ||
		!safeRelative(o.indexPath) ||
		!/\/(binary-amd64\/Packages|source\/Sources)(\.xz|\.gz)?$/.test(o.indexPath)
	)
		throw Error("Invalid offline apt index path");
	if (
		o.expectedSuite !== undefined &&
		release[0]?.get("suite") !== o.expectedSuite &&
		release[0]?.get("codename") !== o.expectedSuite
	)
		throw Error("Apt Release suite mismatch");
	const sums = release[0]?.get("sha256");
	if (!sums) throw Error("Apt Release has no SHA-256 index binding");
	let match = false;
	const paths = new Set<string>();
	for (const line of sums.split("\n").filter(Boolean)) {
		const fields = /^([a-f0-9]{64})\s+(\d+)\s+(.+)$/.exec(line.trim());
		if (!fields?.[3] || paths.has(fields[3]))
			throw Error("Invalid or duplicate Release SHA-256 entry");
		paths.add(fields[3]);
		if (fields[3] === o.indexPath) {
			if (
				Number(fields[2]) !== o.index.length ||
				fields[1] !== createHash("sha256").update(o.index).digest("hex")
			)
				throw Error("Apt Packages checksum mismatch");
			match = true;
		}
	}
	if (!match) throw Error("Packages index absent from signed Release");
}
export async function verifyAptIndex(o: AptIndexInput): Promise<AptPackage[]> {
	if (!o.indexPath.endsWith("/binary-amd64/Packages"))
		throw Error("Unexpected binary package index");
	await verifyAptMetadata(o);
	return parseAptPackages(o.index.toString("utf8"));
}
export interface AptSource {
	name: string;
	version: string;
	files: { filename: string; sha256: string; sizeBytes: number }[];
}
export async function verifyAptSources(o: AptIndexInput): Promise<AptSource[]> {
	if (!o.indexPath.endsWith("/source/Sources"))
		throw Error("Unexpected source package index");
	await verifyAptMetadata(o);
	return records(o.index.toString("utf8")).map((r) => {
		const name = r.get("package") ?? "",
			version = r.get("version") ?? "",
			directory = r.get("directory") ?? "";
		if (
			!/^[a-z0-9][a-z0-9+.-]+$/.test(name) ||
			!version ||
			!directory.startsWith("pool/") ||
			!safeRelative(directory)
		)
			throw Error("Invalid source package identity");
		const seen = new Set<string>();
		const files = (r.get("checksums-sha256") || "")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const match = /^([a-f0-9]{64})\s+(\d+)\s+([^/\s]+)$/.exec(line.trim());
				if (!match?.[1] || !match[2] || !match[3])
					throw Error("Invalid source file checksum");
				const filename = `${directory}/${match[3]}`,
					sizeBytes = Number(match[2]);
				if (
					!safeRelative(filename) ||
					seen.has(filename) ||
					!Number.isSafeInteger(sizeBytes) ||
					sizeBytes <= 0 ||
					sizeBytes > 8 * 1024 ** 3
				)
					throw Error("Unsafe source package file");
				seen.add(filename);
				return { filename, sha256: match[1], sizeBytes };
			});
		if (!files.some((f) => f.filename.endsWith(".dsc")))
			throw Error("Source package omits its dsc");
		return { name, version, files };
	});
}
export interface OfflineRepository {
	name: string;
	suite: string;
	components: string[];
	keyring: string;
}
export function offlineAptSources(repositories: OfflineRepository[]): string {
	if (repositories.length === 0 || repositories.length > 16)
		throw Error("Invalid offline repositories");
	return repositories
		.map((r) => {
			if (
				!/^[a-z][a-z0-9-]*$/.test(r.name) ||
				!/^[a-z][a-z0-9-]*$/.test(r.suite) ||
				r.components.length === 0 ||
				r.components.some((c) => !/^[a-z][a-z0-9-]*$/.test(c)) ||
				!r.keyring.startsWith("/") ||
				/[\r\n ]/.test(r.keyring) ||
				r.keyring.split("/").includes("..")
			)
				throw Error("Invalid offline apt source");
			return `Types: deb\nURIs: file:///mnt/layer/apt/${r.name}\nSuites: ${r.suite}\nComponents: ${r.components.join(" ")}\nArchitectures: amd64\nSigned-By: ${r.keyring}\nCheck-Valid-Until: no\n`;
		})
		.join("\n");
}
