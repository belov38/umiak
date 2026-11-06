// Signed image metadata is compact JSON: exact round-trip rejects duplicate keys.
import { verify } from "node:crypto";
export const IMAGE_LIMITS = Object.freeze({
	metadata: 1024 * 1024,
	chunk: 512 * 1024 * 1024,
	archive: 32 * 1024 ** 3,
	file: 4 * 1024 ** 3,
	files: 4096,
	chunks: 512,
	inventory: 32 * 1024 * 1024,
});
const digest = /^[a-f0-9]{64}$/;
const semver = /^\d+\.\d+\.\d+(?:-edge\.\d{8}\.\d+)?(?:\+[\w.-]+)?$/;
const version = /^\d{8}\.\d+(?:-edge\.\d{8}\.\d+)?$/;
function check(ok, message = "Invalid image metadata") {
	if (!ok) throw Error(message);
}
function object(v, fields) {
	check(v && typeof v === "object" && !Array.isArray(v));
	check(
		Object.keys(v).length === fields.length &&
			fields.every((k) => Object.hasOwn(v, k)),
	);
}
function size(v, max) {
	check(Number.isSafeInteger(v) && v > 0 && v <= max);
}
function hash(v) {
	check(typeof v === "string" && digest.test(v));
}
function text(v) {
	check(
		typeof v === "string" &&
			v.length > 0 &&
			v.length <= 2048 &&
			![...v].some((c) => c.codePointAt(0) < 32),
	);
}
function identity(m, channel) {
	check(["stable", "edge"].includes(channel) && m.channel === channel);
	check(version.test(m.version));
	check((channel === "edge") === m.version.includes("-edge."));
}
function signed({ bytes, signature, keys }) {
	check(Buffer.isBuffer(bytes) && bytes.length <= IMAGE_LIMITS.metadata);
	check(
		Buffer.isBuffer(signature) &&
			signature.length === 64 &&
			Array.isArray(keys) &&
			keys.some((k) => {
				try {
					return verify(null, bytes, k, signature);
				} catch {
					return false;
				}
			}),
		"Image signature verification failed",
	);
	const m = JSON.parse(bytes.toString("utf8"));
	check(
		JSON.stringify(m) === bytes.toString("utf8"),
		"Image metadata must be compact JSON without duplicate fields",
	);
	return m;
}
function compare(a, b) {
	check(
		semver.test(a || "") && semver.test(b || ""),
		"Invalid compatibility version",
	);
	const nums = (v) => v.split("-")[0].split("+")[0].split(".").map(Number);
	const x = nums(a),
		y = nums(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
	return 0;
}
export function verifyImageManifest(options) {
	const m = signed(options);
	object(m, [
		"format",
		"version",
		"slug",
		"channel",
		"arch",
		"distro",
		"release",
		"sourceCommit",
		"recipeSha256",
		"base",
		"aptSnapshot",
		"agent",
		"builderApi",
		"minPlatform",
		"maxPlatform",
		"minAgent",
		"bootTrust",
		"archive",
		"files",
		"inventory",
		"sources",
		"verification",
	]);
	check(m.format === "umiak-linux-layer/v1" && m.arch === "amd64");
	identity(m, options.channel);
	check(["linux", "linux-desktop"].includes(m.slug) && m.slug === options.slug);
	check(m.distro === "ubuntu" && m.release === "26.04");
	check(/^[a-f0-9]{40,64}$/.test(m.sourceCommit));
	hash(m.recipeSha256);
	object(m.base, ["url", "serial", "sha256"]);
	check(/^\d{8}$/.test(m.base.serial));
	check(
		m.base.url ===
			`https://cloud-images.ubuntu.com/minimal/releases/resolute/release-${m.base.serial}/ubuntu-26.04-minimal-cloudimg-amd64.img`,
		"Base must be the unmodified official Canonical image",
	);
	hash(m.base.sha256);
	check(/^\d{8}T\d{6}Z$/.test(m.aptSnapshot));
	object(m.agent, ["version", "sha256"]);
	text(m.agent.version);
	hash(m.agent.sha256);
	check(m.builderApi === 1 && m.bootTrust === "smbios-ca-sha256-v1");
	check(
		compare(options.platform, m.minPlatform) >= 0 &&
			compare(options.platform, m.maxPlatform) < 0 &&
			compare(options.agent, m.minAgent) >= 0,
		"Image incompatible with platform or agent",
	);
	const d = m.archive;
	object(d, ["sizeBytes", "compressedBytes", "sha256", "rawSha256", "chunks"]);
	size(d.sizeBytes, IMAGE_LIMITS.archive);
	size(d.compressedBytes, IMAGE_LIMITS.archive);
	hash(d.sha256);
	hash(d.rawSha256);
	check(
		Array.isArray(d.chunks) &&
			d.chunks.length > 0 &&
			d.chunks.length <= IMAGE_LIMITS.chunks,
	);
	let total = 0;
	for (const c of d.chunks) {
		object(c, ["sha256", "sizeBytes"]);
		hash(c.sha256);
		size(c.sizeBytes, IMAGE_LIMITS.chunk);
		total += c.sizeBytes;
	}
	check(total === d.compressedBytes);
	check(
		Array.isArray(m.files) &&
			m.files.length > 0 &&
			m.files.length <= IMAGE_LIMITS.files,
	);
	const paths = new Set();
	let fileBytes = 0;
	for (const file of m.files) {
		object(file, ["path", "sizeBytes", "sha256", "mode"]);
		check(validLayerPath(file.path) && !paths.has(file.path));
		paths.add(file.path);
		check(
			Number.isSafeInteger(file.sizeBytes) &&
				file.sizeBytes >= 0 &&
				file.sizeBytes <= IMAGE_LIMITS.file,
		);
		hash(file.sha256);
		check([0o644, 0o755].includes(file.mode));
		fileBytes += file.sizeBytes;
	}
	check(fileBytes <= d.sizeBytes);

	object(m.sources, ["repository", "digest"]);
	check(
		typeof m.sources.repository === "string" &&
			m.sources.repository.length <= 255 &&
			/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/.test(
				m.sources.repository,
			),
		"Invalid source companion repository",
	);
	check(
		/^sha256:[a-f0-9]{64}$/.test(m.sources.digest),
		"Source companion requires an immutable OCI digest",
	);
	object(m.inventory, ["sha256", "sizeBytes"]);
	hash(m.inventory.sha256);
	size(m.inventory.sizeBytes, IMAGE_LIMITS.inventory);
	check(
		m.files.some(
			(f) =>
				f.path === "licenses/inventory.json" &&
				f.sha256 === m.inventory.sha256 &&
				f.sizeBytes === m.inventory.sizeBytes,
		),
		"Layer is missing its signed license inventory file",
	);
	object(m.verification, ["ok", "offlineReplay"]);
	check(m.verification.ok === true && m.verification.offlineReplay === true);
	return m;
}
export function verifyImagePointer(options) {
	const m = signed(options);
	object(m, ["format", "channel", "sequence", "version", "images"]);
	check(m.format === "umiak-linux-channel/v1");
	identity(m, options.channel);
	size(m.sequence, Number.MAX_SAFE_INTEGER);
	check(
		m.sequence >= (options.minimumSequence || 0),
		"Image channel rollback rejected",
	);
	object(m.images, ["linux", "linux-desktop"]);
	hash(m.images.linux);
	hash(m.images["linux-desktop"]);
	return m;
}
/** Outer layer files are inert inputs; no disk images, links or path escapes. */
export function validLayerPath(path) {
	return (
		typeof path === "string" &&
		path.length <= 512 &&
		/^(apt|inputs|build|licenses|recipes)\/[A-Za-z0-9_@+.,=~:/-]+$/.test(
			path,
		) &&
		path.split("/").every((p) => p !== "" && p !== "." && p !== "..") &&
		!/\.(?:qcow2?|raw|img|vmdk|vdi|iso)$/i.test(path)
	);
}
