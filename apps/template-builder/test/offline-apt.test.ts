import { createHash } from "node:crypto";
import * as openpgp from "openpgp";
import { expect, it } from "vitest";
import {
	offlineAptSources,
	parseAptPackages,
	verifyAptIndex,
} from "../src/offline-apt.ts";

const deb = Buffer.from("fixture deb");
const sha = createHash("sha256").update(deb).digest("hex");
const packages = `Package: fixture\nVersion: 1.2.3\nArchitecture: amd64\nFilename: pool/main/f/fixture/fixture_1.2.3_amd64.deb\nSize: ${deb.length}\nSHA256: ${sha}\nSource: fixture (1.2.3)\n\n`;
it("authenticates original Release -> Packages -> unmodified deb provenance offline", async () => {
	const key = await openpgp.generateKey({
		type: "ecc",
		curve: "ed25519Legacy",
		userIDs: [{ name: "fixture archive" }],
		format: "armored",
	});
	const privateKey = await openpgp.readPrivateKey({
		armoredKey: key.privateKey,
	});
	const pub = await openpgp.readKey({ armoredKey: key.publicKey });
	const index = Buffer.from(packages);
	const hash = createHash("sha256").update(index).digest("hex");
	const signed = await openpgp.sign({
		message: await openpgp.createCleartextMessage({
			text: `Origin: Fixture\nSuite: resolute\nSHA256:\n ${hash} ${index.length} main/binary-amd64/Packages\n`,
		}),
		signingKeys: privateKey,
	});
	const opts = {
		inRelease: String(signed),
		publicKey: key.publicKey,
		keyFingerprint: pub.getFingerprint(),
		indexPath: "main/binary-amd64/Packages",
		index,
	};
	expect((await verifyAptIndex(opts))[0]).toMatchObject({
		name: "fixture",
		version: "1.2.3",
		sha256: sha,
		sizeBytes: deb.length,
	});
	await expect(
		verifyAptIndex({ ...opts, publicKey: key.publicKey + key.publicKey }),
	).rejects.toThrow(/exactly one/);
	await expect(
		verifyAptIndex({ ...opts, index: Buffer.from(`${packages}changed`) }),
	).rejects.toThrow();
	await expect(
		verifyAptIndex({ ...opts, keyFingerprint: "a".repeat(40) }),
	).rejects.toThrow();
});
it("rejects unsafe pool paths, duplicate fields and missing hashes", () => {
	for (const bad of [
		packages.replace(
			"pool/main/f/fixture/fixture_1.2.3_amd64.deb",
			"../outside",
		),
		packages.replace("SHA256:", `Package: override\nSHA256:`),
		packages.replace(`SHA256: ${sha}\n`, ""),
	])
		expect(() => parseAptPackages(bad)).toThrow();
});
it("offline source definitions preserve key authorities and forbid network repositories", () => {
	const sources = offlineAptSources([
		{
			name: "ubuntu",
			suite: "resolute",
			components: ["main", "universe"],
			keyring: "/usr/share/keyrings/ubuntu-archive-keyring.gpg",
		},
	]);
	expect(sources).toContain("URIs: file:///mnt/layer/apt/ubuntu");
	expect(sources).toContain(
		"Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
	);
	expect(sources).not.toContain("trusted=yes");
	expect(sources).not.toContain("http:");
	expect(() =>
		offlineAptSources([
			{
				name: "../escape",
				suite: "resolute",
				components: ["main"],
				keyring: "/key",
			},
		]),
	).toThrow();
});
it("preserves Docker's original dists/suite/pool package layout", () => {
	const docker = packages.replace(
		"pool/main/f/fixture/fixture_1.2.3_amd64.deb",
		"dists/resolute/pool/stable/amd64/fixture_1.2.3_amd64.deb",
	);
	expect(parseAptPackages(docker)[0]?.filename).toBe(
		"dists/resolute/pool/stable/amd64/fixture_1.2.3_amd64.deb",
	);
});

it("binds dsc/orig/debian source files to the original signed Sources index", async () => {
	const { verifyAptSources } = await import("../src/offline-apt.ts");
	const key = await openpgp.generateKey({
		type: "ecc",
		curve: "ed25519Legacy",
		userIDs: [{ name: "fixture source archive" }],
		format: "armored",
	});
	const pub = await openpgp.readKey({ armoredKey: key.publicKey });
	const index = Buffer.from(
		`Package: fixture\nVersion: 1.2.3\nDirectory: pool/main/f/fixture\nChecksums-Sha256:\n ${sha} 11 fixture_1.2.3.dsc\n ${sha} 11 fixture_1.2.3.orig.tar.xz\n\n`,
	);
	const indexHash = createHash("sha256").update(index).digest("hex");
	const signed = await openpgp.sign({
		message: await openpgp.createCleartextMessage({
			text: `Suite: resolute\nSHA256:\n ${indexHash} ${index.length} main/source/Sources\n`,
		}),
		signingKeys: await openpgp.readPrivateKey({ armoredKey: key.privateKey }),
	});
	const opts = {
		inRelease: String(signed),
		publicKey: key.publicKey,
		keyFingerprint: pub.getFingerprint(),
		indexPath: "main/source/Sources",
		index,
		expectedSuite: "resolute",
	};
	expect((await verifyAptSources(opts))[0]).toMatchObject({
		name: "fixture",
		version: "1.2.3",
		files: [
			{
				filename: "pool/main/f/fixture/fixture_1.2.3.dsc",
				sha256: sha,
				sizeBytes: 11,
			},
			{
				filename: "pool/main/f/fixture/fixture_1.2.3.orig.tar.xz",
				sha256: sha,
				sizeBytes: 11,
			},
		],
	});
	await expect(
		verifyAptSources({
			...opts,
			index: Buffer.from(
				index.toString().replace("pool/main/f/fixture", "../escape"),
			),
		}),
	).rejects.toThrow();
});
