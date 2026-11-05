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
