import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as openpgp from "openpgp";
import type { Versions } from "./recipe.ts";
import {
	BASE_IMAGE,
	type Fetch,
	findChecksum,
	UBUNTU_MINIMAL,
} from "./versions-update.ts";

// Base image: download and verification (spec S5 section 6.1)

/**
 * A `Fetch` response that also gives the raw bytes and a body stream: the
 * detached signature is binary and the image is too large to buffer.
 */
export type DownloadFetch = (url: string) => Promise<
	Awaited<ReturnType<Fetch>> & {
		arrayBuffer(): Promise<ArrayBuffer>;
		body: AsyncIterable<Uint8Array> | null;
	}
>;

/** Global fetch without a total timeout: an image download takes minutes. Node still applies its header and body idle timeouts. */
export const defaultDownloadFetch: DownloadFetch = (url) =>
	fetch(url, { headers: { "User-Agent": "umiak-tpl" } });

export function imageFileName(_base: Versions["base"]): string {
	return BASE_IMAGE;
}

/** Name of the image in the Proxmox `local:import` storage. */
export function pveImageName(serial: string): string {
	return serial.includes("-")
		? `umiak-debian-13-genericcloud-${serial}.qcow2`
		: `umiak-ubuntu-26.04-minimal-${serial}.qcow2`;
}

/** Fingerprint of the Ubuntu Cloud Image signing key committed in infra/templates/keys/. */
export const UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT =
	"d2eb44626fddc30b513d5bb71a5d6c4c7db87c81";

const ARMOR_PREFIX = "-----BEGIN PGP";

async function readSingleKey(armored: string): Promise<openpgp.Key> {
	const keys = await openpgp.readKeys({ armoredKeys: armored });
	const [key] = keys;
	if (keys.length !== 1 || !key)
		throw new Error(
			`pinned key file holds ${keys.length} keys, want exactly 1`,
		);
	return key;
}

/** Throws unless `armored` holds exactly one key with the given fingerprint. */
export async function assertPinnedKey(
	armored: string,
	fingerprint: string,
): Promise<void> {
	const key = await readSingleKey(armored);
	if (key.getFingerprint() !== fingerprint)
		throw new Error(
			`pinned key has fingerprint ${key.getFingerprint()}, want ${fingerprint}`,
		);
}

/** Verifies a detached signature (binary or armored) of the SHA256SUMS text against the pinned key. */
export async function verifySha256Sums(
	sumsText: string,
	sigArmoredOrBinary: Uint8Array,
	pinnedKeyArmored: string,
): Promise<void> {
	const verificationKeys = await readSingleKey(pinnedKeyArmored);
	const armored =
		Buffer.from(sigArmoredOrBinary.subarray(0, ARMOR_PREFIX.length)).toString(
			"latin1",
		) === ARMOR_PREFIX;
	const signature = armored
		? await openpgp.readSignature({
				armoredSignature: Buffer.from(sigArmoredOrBinary).toString("utf8"),
			})
		: await openpgp.readSignature({ binarySignature: sigArmoredOrBinary });
	const result = await openpgp.verify({
		message: await openpgp.createMessage({ binary: Buffer.from(sumsText) }),
		signature,
		verificationKeys,
	});
	if (result.signatures.length === 0)
		throw new Error("SHA256SUMS: no signature");
	for (const s of result.signatures) {
		try {
			await s.verified;
		} catch (err) {
			throw new Error(
				`SHA256SUMS: signature does not verify with the pinned key: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function getBytes(
	fetch: DownloadFetch,
	url: string,
): Promise<Uint8Array> {
	const res = await fetch(url);
	if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/** Streams the image to `<dest>.part`, hashing on the way, and renames it once the sha256 matches. */
async function download(
	fetch: DownloadFetch,
	url: string,
	dest: string,
	want: string,
): Promise<string> {
	const res = await fetch(url);
	if (res.status !== 200) throw new Error(`GET ${url}: HTTP ${res.status}`);
	if (!res.body) throw new Error(`GET ${url}: empty body`);
	const part = `${dest}.part`;
	const hash = createHash("sha256");
	try {
		await pipeline(
			res.body,
			async function* (source: AsyncIterable<Uint8Array>) {
				for await (const chunk of source) {
					hash.update(chunk);
					yield chunk;
				}
			},
			createWriteStream(part),
		);
		const got = hash.digest("hex");
		if (got !== want)
			throw new Error(`${url}: sha256 mismatch: got ${got}, want ${want}`);
		renameSync(part, dest);
		return got;
	} catch (err) {
		rmSync(part, { force: true });
		throw err;
	}
}

/**
 * Downloads the base image to `<cacheDir>/<serial>/` after checking the
 * signed SHA256SUMS against the pinned key and `base.sha256` against the
 * signed listing. A cached file whose sha256 matches is reused.
 */
export async function fetchBaseImage(o: {
	fetch: DownloadFetch;
	cacheDir: string;
	base: Versions["base"];
	keyFile: string;
	/** Expected fingerprint of `keyFile`; the default is the Ubuntu key. Tests override it. */
	keyFingerprint?: string;
}): Promise<{ path: string; sha256: string }> {
	const name = imageFileName(o.base);
	const releaseUrl = `${UBUNTU_MINIMAL}release-${o.base.serial}/`;
	const sums = await getBytes(o.fetch, `${releaseUrl}SHA256SUMS`);
	const sig = await getBytes(o.fetch, `${releaseUrl}SHA256SUMS.gpg`);
	const sumsText = Buffer.from(sums).toString("utf8");
	const key = readFileSync(o.keyFile, "utf8");
	await assertPinnedKey(
		key,
		o.keyFingerprint ?? UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT,
	);
	await verifySha256Sums(sumsText, sig, key);
	const signed = findChecksum(sumsText, name, `${releaseUrl}SHA256SUMS`);
	if (signed !== o.base.sha256)
		throw new Error(
			`${name}: pinned base.sha256 ${o.base.sha256} differs from the signed SHA256SUMS (${signed})`,
		);

	const dir = join(o.cacheDir, o.base.serial);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	if (existsSync(path) && (await fileSha256(path)) === signed)
		return { path, sha256: signed };
	const sha256 = await download(o.fetch, `${releaseUrl}${name}`, path, signed);
	return { path, sha256 };
}

/** Archive of the virtio-win releases (spec S9 section 6.2). */
export const VIRTIO_WIN_ARCHIVE =
	"https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/";

export function virtioWinUrl(version: string): string {
	return `${VIRTIO_WIN_ARCHIVE}virtio-win-${version}-1/virtio-win-${version}.iso`;
}

/**
 * Downloads `virtio-win-<v>.iso` into `cacheDir` and checks it against the pinned sha256; a
 * cached file with that sha256 is reused.
 */
export async function fetchVirtioWin(o: {
	fetch: DownloadFetch;
	cacheDir: string;
	virtioWin: { version: string; sha256: string };
}): Promise<{ path: string; sha256: string }> {
	const { version, sha256 } = o.virtioWin;
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`invalid virtio-win version "${version}"`);
	mkdirSync(o.cacheDir, { recursive: true });
	const path = join(o.cacheDir, `virtio-win-${version}.iso`);
	if (existsSync(path) && (await fileSha256(path)) === sha256)
		return { path, sha256 };
	const got = await download(o.fetch, virtioWinUrl(version), path, sha256);
	return { path, sha256: got };
}
