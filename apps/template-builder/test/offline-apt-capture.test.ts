import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as openpgp from "openpgp";
import { expect, it } from "vitest";
import { captureAptRepository } from "../src/offline-apt-capture.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "umiak-apt-fixture-"));
	const deb = Buffer.from("unmodified fixture package");
	const sha256 = createHash("sha256").update(deb).digest("hex");
	const filename = "pool/main/f/fixture/fixture_1.2.3_amd64.deb";
	const index = Buffer.from(
		`Package: fixture\nVersion: 1.2.3\nArchitecture: amd64\nFilename: ${filename}\nSize: ${deb.length}\nSHA256: ${sha256}\n\n`,
	);
	const generated = await openpgp.generateKey({
		type: "ecc",
		curve: "ed25519Legacy",
		userIDs: [{ name: "test archive" }],
		format: "armored",
	});
	const key = await openpgp.readPrivateKey({
		armoredKey: generated.privateKey,
	});
	const publicKey = await openpgp.readKey({ armoredKey: generated.publicKey });
	const hash = createHash("sha256").update(index).digest("hex");
	const inRelease = String(
		await openpgp.sign({
			message: await openpgp.createCleartextMessage({
				text: `Origin: Fixture\nSuite: resolute\nSHA256:\n ${hash} ${index.length} main/binary-amd64/Packages\n`,
			}),
			signingKeys: key,
		}),
	);
	const path = join(root, "input.deb");
	await writeFile(path, deb);
	return {
		root,
		deb,
		filename,
		options: {
			directory: join(root, "apt"),
			repository: {
				name: "fixture",
				suite: "resolute",
				components: ["main"],
				keyring: "/mnt/layer/apt/fixture/archive.asc",
			},
			publicKey: generated.publicKey,
			keyFingerprint: publicKey.getFingerprint(),
			inRelease,
			indexes: [{ path: "main/binary-amd64/Packages", bytes: index }],
			debs: [{ path, sha256 }],
		},
	};
}
it("captures original signed metadata and exact package bytes into apt's mirror layout", async () => {
	const f = await fixture();
	try {
		const result = await captureAptRepository(f.options);
		expect(result.packages).toMatchObject([
			{ name: "fixture", version: "1.2.3", filename: f.filename },
		]);
		expect(
			await readFile(join(f.options.directory, "fixture", f.filename)),
		).toEqual(f.deb);
		expect(
			await readFile(
				join(f.options.directory, "fixture/dists/resolute/InRelease"),
				"utf8",
			),
		).toBe(f.options.inRelease);
		expect(result.sources).toContain("file:///mnt/layer/apt/fixture");
		expect(result.sources).not.toContain("trusted=yes");
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
it("fails closed on substituted or unsigned packages, wrong suites, and duplicate indexes", async () => {
	const f = await fixture();
	try {
		await expect(
			captureAptRepository({
				...f.options,
				repository: { ...f.options.repository, suite: "different" },
			}),
		).rejects.toThrow(/suite/i);
		await expect(
			captureAptRepository({
				...f.options,
				indexes: [...f.options.indexes, ...f.options.indexes],
			}),
		).rejects.toThrow(/duplicate/i);
		await expect(
			captureAptRepository({
				...f.options,
				debs: [{ path: f.options.debs[0]?.path ?? "", sha256: "f".repeat(64) }],
			}),
		).rejects.toThrow(/signed Packages/i);
		await writeFile(f.options.debs[0]?.path ?? "", "substituted");
		await expect(captureAptRepository(f.options)).rejects.toThrow(
			/checksum|size/i,
		);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
