// Signed image metadata is compact JSON: exact round-trip rejects duplicate keys.
import { verify } from "node:crypto";
export const IMAGE_LIMITS = Object.freeze({
	metadata: 1024 * 1024,
	chunk: 512 * 1024 * 1024,
	disk: 256 * 1024 ** 3,
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
		"hardware",
		"disks",
		"inventory",
		"verification",
	]);
	check(m.format === "umiak-linux-image/v1" && m.arch === "amd64");
	identity(m, options.channel);
	check(["linux", "linux-desktop"].includes(m.slug) && m.slug === options.slug);
	text(m.distro);
	text(m.release);
	check(/^[a-f0-9]{40,64}$/.test(m.sourceCommit));
	hash(m.recipeSha256);
	object(m.base, ["url", "serial", "sha256"]);
	const base = new URL(m.base.url);
	check(base.protocol === "https:" && !base.username && !base.password);
	text(m.base.serial);
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
	object(m.hardware, ["bios", "scsihw", "machine"]);
	check(
		["seabios", "ovmf"].includes(m.hardware.bios) &&
			m.hardware.scsihw === "virtio-scsi-single" &&
			m.hardware.machine === "q35",
	);
	check(Array.isArray(m.disks) && m.disks.length > 0 && m.disks.length <= 3);
	const slots = new Set();
	for (const d of m.disks) {
		object(d, [
			"slot",
			"sizeBytes",
			"compressedBytes",
			"sha256",
			"rawSha256",
			"chunks",
		]);
		check(
			["scsi0", "efidisk0", "tpmstate0"].includes(d.slot) && !slots.has(d.slot),
		);
		slots.add(d.slot);
		size(d.sizeBytes, IMAGE_LIMITS.disk);
		check(d.sizeBytes % 512 === 0);
		size(d.compressedBytes, IMAGE_LIMITS.disk);
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
	}
	check(slots.has("scsi0"));
	object(m.inventory, ["sha256", "sizeBytes"]);
	hash(m.inventory.sha256);
	size(m.inventory.sizeBytes, IMAGE_LIMITS.inventory);
	object(m.verification, ["ok"]);
	check(m.verification.ok === true);
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
export function imageObjectUrl(base, key) {
	const u = new URL(base);
	check(
		u.protocol === "https:" &&
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash,
		"Image base must be HTTPS",
	);
	check(
		typeof key === "string" &&
			/^(?:blobs\/sha256\/[a-f0-9]{64}|channels\/(?:stable|edge)\.json(?:\.sig)?|releases\/[0-9.edge-]+\/(?:linux|linux-desktop)\/manifest\.(?:json|sig))$/.test(
				key,
			),
		"Invalid image object key",
	);
	u.pathname = `${u.pathname.replace(/\/$/, "")}/${key}`;
	return u.toString();
}
