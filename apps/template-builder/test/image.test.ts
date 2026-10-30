import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import * as openpgp from "openpgp";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	assertPinnedKey,
	type DownloadFetch,
	fetchBaseImage,
	imageFileName,
	pveImageName,
	UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT,
	verifySha256Sums,
} from "../src/image.ts";
import { loadRecipe, loadVersions } from "../src/recipe.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const pinnedKeyFile = join(
	repoRoot,
	"infra/templates/keys/ubuntu-cloud-images.asc",
);
const ubuntuFixtures = resolve(import.meta.dirname, "fixtures/ubuntu");

const UBUNTU_FINGERPRINT = "d2eb44626fddc30b513d5bb71a5d6c4c7db87c81";
const IMAGE = "ubuntu-26.04-minimal-cloudimg-amd64.img";
const RELEASE_URL =
	"https://cloud-images.ubuntu.com/minimal/releases/resolute/release-20261024/";

const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sbx-image-test-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0))
		rmSync(d, { recursive: true, force: true });
});

interface TestKey {
	privateKey: string;
	publicKey: string;
	fingerprint: string;
}
async function newKey(): Promise<TestKey> {
	const { privateKey, publicKey } = await openpgp.generateKey({
		type: "ecc",
		userIDs: [{ name: "sbx test" }],
		format: "armored",
	});
	const fingerprint = (
		await openpgp.readKey({ armoredKey: publicKey })
	).getFingerprint();
	return { privateKey, publicKey, fingerprint };
}

async function detachSign(
	text: string,
	key: TestKey,
	format: "armored" | "binary",
): Promise<Uint8Array> {
	const message = await openpgp.createMessage({ binary: Buffer.from(text) });
	const signingKeys = await openpgp.readPrivateKey({
		armoredKey: key.privateKey,
	});
	if (format === "armored")
		return new TextEncoder().encode(
			await openpgp.sign({ message, signingKeys, detached: true }),
		);
	return openpgp.sign({ message, signingKeys, detached: true, format });
}

let keyA: TestKey;
let keyB: TestKey;
beforeAll(async () => {
	keyA = await newKey();
	keyB = await newKey();
});

describe("names", () => {
	it("derives the image and Proxmox import names", () => {
		const base = { serial: "20261024", sha256: "0".repeat(64) };
		expect(imageFileName(base)).toBe(IMAGE);
		expect(pveImageName("20261024")).toBe(
			"sbx-ubuntu-26.04-minimal-20261024.qcow2",
		);
	});
});

describe("pinned Ubuntu key", () => {
	it("has the Ubuntu Cloud Image signing key fingerprint", async () => {
		const key = await openpgp.readKey({
			armoredKey: readFileSync(pinnedKeyFile, "utf8"),
		});
		expect(key.getFingerprint()).toBe(UBUNTU_FINGERPRINT);
	});

	it("verifies the real release-20261024 SHA256SUMS", async () => {
		await verifySha256Sums(
			readFileSync(join(ubuntuFixtures, "SHA256SUMS"), "utf8"),
			readFileSync(join(ubuntuFixtures, "SHA256SUMS.gpg")),
			readFileSync(pinnedKeyFile, "utf8"),
		);
	});

	it("asserts exactly one key with the expected fingerprint", async () => {
		await assertPinnedKey(
			readFileSync(pinnedKeyFile, "utf8"),
			UBUNTU_FINGERPRINT,
		);
		await expect(
			assertPinnedKey(keyA.publicKey, UBUNTU_FINGERPRINT),
		).rejects.toThrow(/fingerprint/);
		const ubuntu = await openpgp.readKey({
			armoredKey: readFileSync(pinnedKeyFile, "utf8"),
		});
		const a = await openpgp.readKey({ armoredKey: keyA.publicKey });
		const two = openpgp.armor(
			openpgp.enums.armor.publicKey,
			Buffer.concat([ubuntu.write(), a.write()]),
		);
		await expect(assertPinnedKey(two, UBUNTU_FINGERPRINT)).rejects.toThrow(
			/2 keys/,
		);
		await expect(verifySha256Sums("x", new Uint8Array(0), two)).rejects.toThrow(
			/2 keys/,
		);
	});

	it("rejects the real SHA256SUMS with one changed digit", async () => {
		const text = readFileSync(join(ubuntuFixtures, "SHA256SUMS"), "utf8");
		const tampered = `${text[0] === "0" ? "1" : "0"}${text.slice(1)}`;
		await expect(
			verifySha256Sums(
				tampered,
				readFileSync(join(ubuntuFixtures, "SHA256SUMS.gpg")),
				readFileSync(pinnedKeyFile, "utf8"),
			),
		).rejects.toThrow();
	});

	it("exports the fingerprint of the committed key", () => {
		expect(UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT).toBe(UBUNTU_FINGERPRINT);
	});

	it("matches the sha256 pinned in versions.toml", () => {
		const recipe = loadRecipe(
			join(repoRoot, "infra/templates"),
			"linux",
			"linux",
		);
		const sums = readFileSync(join(ubuntuFixtures, "SHA256SUMS"), "utf8");
		expect(sums).toContain(`${loadVersions(recipe).base.sha256} *${IMAGE}`);
	});
});

describe("verifySha256Sums", () => {
	const sums = `${sha("image")} *${IMAGE}\n`;

	it("accepts binary and armored detached signatures", async () => {
		for (const format of ["binary", "armored"] as const) {
			const sig = await detachSign(sums, keyA, format);
			await verifySha256Sums(sums, sig, keyA.publicKey);
		}
	});

	it("rejects tampered text", async () => {
		const sig = await detachSign(sums, keyA, "binary");
		await expect(
			verifySha256Sums(
				sums.replace("a", "b").replace("1", "2"),
				sig,
				keyA.publicKey,
			),
		).rejects.toThrow();
	});

	it("rejects a signature by a key that is not pinned", async () => {
		const sig = await detachSign(sums, keyB, "binary");
		await expect(verifySha256Sums(sums, sig, keyA.publicKey)).rejects.toThrow();
	});

	it("rejects an empty or garbage signature", async () => {
		await expect(
			verifySha256Sums(sums, new Uint8Array(0), keyA.publicKey),
		).rejects.toThrow();
		await expect(
			verifySha256Sums(sums, new Uint8Array([1, 2, 3, 4]), keyA.publicKey),
		).rejects.toThrow();
	});
});

describe("fetchBaseImage", () => {
	const imageBytes = Buffer.from("pretend this is a qcow2 image");

	interface Setup {
		keyFingerprint: string;
		fetch: DownloadFetch;
		urls: string[];
		cacheDir: string;
		keyFile: string;
		base: { serial: string; sha256: string };
	}

	async function setup(
		o: {
			sums?: string;
			served?: Buffer;
			sigKey?: TestKey;
			status?: Record<string, number>;
		} = {},
	): Promise<Setup> {
		const dir = tmp();
		const keyFile = join(dir, "key.asc");
		writeFileSync(keyFile, keyA.publicKey);
		const sums = o.sums ?? `${sha(imageBytes)} *${IMAGE}\n`;
		const sig = await detachSign(sums, o.sigKey ?? keyA, "binary");
		const served = o.served ?? imageBytes;
		const urls: string[] = [];
		const fetch: DownloadFetch = async (url) => {
			urls.push(url);
			const status = o.status?.[url] ?? 200;
			const body =
				url === `${RELEASE_URL}SHA256SUMS`
					? Buffer.from(sums)
					: url === `${RELEASE_URL}SHA256SUMS.gpg`
						? Buffer.from(sig)
						: url === `${RELEASE_URL}${IMAGE}`
							? served
							: null;
			if (body === null)
				return {
					status: 404,
					arrayBuffer: async () => new ArrayBuffer(0),
					body: null,
					text: async () => "",
				};
			return {
				status,
				text: async () => body.toString(),
				arrayBuffer: async () =>
					body.buffer.slice(
						body.byteOffset,
						body.byteOffset + body.byteLength,
					) as ArrayBuffer,
				// Two chunks to exercise the streaming path.
				body: Readable.from([body.subarray(0, 5), body.subarray(5)]),
			};
		};
		return {
			fetch,
			urls,
			cacheDir: join(dir, "cache"),
			keyFile,
			keyFingerprint: keyA.fingerprint,
			base: { serial: "20261024", sha256: sha(imageBytes) },
		};
	}

	it("refuses a key file whose fingerprint is not the pinned Ubuntu key", async () => {
		const s = await setup();
		const { keyFingerprint: _, ...o } = s;
		await expect(fetchBaseImage(o)).rejects.toThrow(/fingerprint/);
		expect(s.urls).toEqual([
			`${RELEASE_URL}SHA256SUMS`,
			`${RELEASE_URL}SHA256SUMS.gpg`,
		]);
	});

	it("downloads, verifies and caches under <cacheDir>/<serial>", async () => {
		const s = await setup();
		const r = await fetchBaseImage(s);
		expect(r).toEqual({
			path: join(s.cacheDir, "20261024", IMAGE),
			sha256: sha(imageBytes),
		});
		expect(readFileSync(r.path)).toEqual(imageBytes);
		expect(readdirSync(join(s.cacheDir, "20261024"))).toEqual([IMAGE]);
		expect(s.urls).toEqual([
			`${RELEASE_URL}SHA256SUMS`,
			`${RELEASE_URL}SHA256SUMS.gpg`,
			`${RELEASE_URL}${IMAGE}`,
		]);
	});

	it("reuses a cached file with a matching sha256 without fetching the image", async () => {
		const s = await setup();
		mkdirSync(join(s.cacheDir, "20261024"), { recursive: true });
		writeFileSync(join(s.cacheDir, "20261024", IMAGE), imageBytes);
		const r = await fetchBaseImage(s);
		expect(r.sha256).toBe(sha(imageBytes));
		expect(s.urls).not.toContain(`${RELEASE_URL}${IMAGE}`);
	});

	it("replaces a cached file whose sha256 does not match", async () => {
		const s = await setup();
		mkdirSync(join(s.cacheDir, "20261024"), { recursive: true });
		const file = join(s.cacheDir, "20261024", IMAGE);
		writeFileSync(file, "corrupt");
		await fetchBaseImage(s);
		expect(readFileSync(file)).toEqual(imageBytes);
	});

	it("refuses a base.sha256 that differs from the signed listing", async () => {
		const s = await setup();
		await expect(
			fetchBaseImage({ ...s, base: { ...s.base, sha256: sha("other") } }),
		).rejects.toThrow(/pinned/);
		expect(s.urls).not.toContain(`${RELEASE_URL}${IMAGE}`);
		expect(existsSync(s.cacheDir)).toBe(false);
	});

	it("refuses a listing signed by another key before reading it", async () => {
		const s = await setup({ sigKey: keyB });
		await expect(fetchBaseImage(s)).rejects.toThrow();
		expect(s.urls).not.toContain(`${RELEASE_URL}${IMAGE}`);
	});

	it("refuses a listing without an entry for the image", async () => {
		const s = await setup({ sums: `${sha("x")} *other.img\n` });
		await expect(fetchBaseImage(s)).rejects.toThrow(/no sha256 entry/);
	});

	it("rejects a downloaded image with the wrong sha256 and leaves nothing behind", async () => {
		const s = await setup({ served: Buffer.from("tampered image bytes") });
		await expect(fetchBaseImage(s)).rejects.toThrow(/sha256 mismatch/);
		expect(readdirSync(join(s.cacheDir, "20261024"))).toEqual([]);
	});

	it("rejects a non-200 response", async () => {
		const s = await setup({
			status: { [`${RELEASE_URL}${IMAGE}`]: 503 },
		});
		await expect(fetchBaseImage(s)).rejects.toThrow(/HTTP 503/);
		expect(readdirSync(join(s.cacheDir, "20261024"))).toEqual([]);
	});

	it("rejects the real signed listing when the image differs from the pin", async () => {
		const s = await setup();
		const realKey = join(
			repoRoot,
			"infra/templates/keys/ubuntu-cloud-images.asc",
		);
		const realSums = readFileSync(join(ubuntuFixtures, "SHA256SUMS"));
		const realSig = readFileSync(join(ubuntuFixtures, "SHA256SUMS.gpg"));
		const urls: string[] = [];
		const fetch: DownloadFetch = async (url) => {
			urls.push(url);
			const body = url.endsWith("SHA256SUMS")
				? realSums
				: url.endsWith("SHA256SUMS.gpg")
					? realSig
					: Buffer.from("not the real image");
			return {
				status: 200,
				text: async () => body.toString(),
				arrayBuffer: async () =>
					body.buffer.slice(
						body.byteOffset,
						body.byteOffset + body.byteLength,
					) as ArrayBuffer,
				body: Readable.from([body]),
			};
		};
		const realBase = {
			serial: "20261024",
			sha256:
				"6c083e6bea1573aab619c1dfa8d17bb7e3a8618fbd6cb57fa39d517b20062aa4",
		};
		await expect(
			fetchBaseImage({
				fetch,
				cacheDir: s.cacheDir,
				base: realBase,
				keyFile: realKey,
			}),
		).rejects.toThrow(/sha256 mismatch/);
		expect(urls).toHaveLength(3);
	});
});
