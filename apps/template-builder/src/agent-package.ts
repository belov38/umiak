import {
	createHash,
	createPublicKey,
	type KeyObject,
	verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { entryName, readTar } from "./tar.ts";

// Verification of a signed sbx-agent package on the build machine (spec S5
// section 7.2 step 1). Mirrors services/guest-agent/internal/update: package
// layout in pkg.go (Pack), checks in Verify and checkManifest, key file in
// keys.go (ParseKeys), names in manifest.go.

const MANIFEST_FORMAT = "sbx-agent-manifest/v1";
const BINARY_NAME = "sbx-agent";
const MANIFEST_NAME = "manifest.json";
const SIGNATURE_NAME = "manifest.sig";
const REQUIRED_FILES = [
	BINARY_NAME,
	"trust/tunnel-ca.pem",
	"trust/update-keys.pub",
];
const SIGNATURE_SIZE = 64;
const PUBLIC_KEY_SIZE = 32;
const KEY_TYPE = "ed25519";
const KEY_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;
const VERSION_RE = /^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,63}$/;

const manifestSchema = z.object({
	format: z.literal(MANIFEST_FORMAT),
	version: z.string().regex(VERSION_RE, "invalid version"),
	os: z.string().min(1),
	arch: z.string().min(1),
	files: z.record(z.string(), z.string().length(64)),
});

export interface AgentPackageInfo {
	version: string;
	os: string;
	arch: string;
	/** sha256 of the package tar. */
	sha256: string;
}

/** Mirrors ParseKeys in keys.go. */
function parseKeys(text: string): KeyObject[] {
	const keys: KeyObject[] = [];
	for (const [i, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const fields = line.split(/\s+/);
		if (fields.length < 2 || fields[0] !== KEY_TYPE)
			throw new Error(
				`keys line ${i + 1}: want "${KEY_TYPE} <base64> [comment]"`,
			);
		// Strict like Go's base64.StdEncoding: padded, no line breaks or other characters.
		if (!KEY_BASE64_RE.test(fields[1] as string))
			throw new Error(
				`keys line ${i + 1}: key is not standard base64 of ${PUBLIC_KEY_SIZE} bytes`,
			);
		const key = Buffer.from(fields[1] as string, "base64");
		if (key.length !== PUBLIC_KEY_SIZE)
			throw new Error(
				`keys line ${i + 1}: key is ${key.length} bytes, want ${PUBLIC_KEY_SIZE}`,
			);
		keys.push(
			createPublicKey({
				key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
				format: "jwk",
			}),
		);
	}
	if (keys.length === 0) throw new Error("no keys");
	return keys;
}

const sha256Hex = (data: Buffer) =>
	createHash("sha256").update(data).digest("hex");

/**
 * Checks the ed25519 signature of manifest.json (raw 64 bytes over the exact
 * manifest bytes) against any key of the update keys file, every file listed
 * in the manifest, and that the package is for linux/amd64.
 */
export function verifyAgentPackage(
	tarPath: string,
	updateKeysFile: string,
): AgentPackageInfo {
	const keys = parseKeys(readFileSync(updateKeysFile, "utf8"));
	const tar = readFileSync(tarPath);
	const where = (msg: string) => new Error(`${tarPath}: ${msg}`);
	let files: Map<string, Buffer>;
	try {
		files = readTar(tar);
	} catch (err) {
		throw where(err instanceof Error ? err.message : String(err));
	}

	const mbytes = files.get(MANIFEST_NAME);
	if (!mbytes) throw where(`${MANIFEST_NAME} is missing`);
	const sig = files.get(SIGNATURE_NAME);
	if (!sig) throw where(`${SIGNATURE_NAME} is missing`);
	if (sig.length !== SIGNATURE_SIZE)
		throw where(`signature is ${sig.length} bytes, want ${SIGNATURE_SIZE}`);
	if (!keys.some((k) => verify(null, mbytes, k, sig)))
		throw where("manifest signature matches no trusted key");

	let manifest: z.infer<typeof manifestSchema>;
	try {
		manifest = manifestSchema.parse(JSON.parse(mbytes.toString("utf8")));
	} catch (err) {
		throw where(
			`bad manifest: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	for (const name of Object.keys(manifest.files)) {
		let clean: string | null = null;
		try {
			clean = entryName(name);
		} catch {}
		if (clean !== name || name === MANIFEST_NAME || name === SIGNATURE_NAME)
			throw where(`manifest lists bad file name ${JSON.stringify(name)}`);
	}
	for (const name of REQUIRED_FILES)
		if (!(name in manifest.files))
			throw where(`manifest does not list ${name}`);

	for (const [name, data] of files) {
		if (name === MANIFEST_NAME || name === SIGNATURE_NAME) continue;
		const want = manifest.files[name];
		if (want === undefined) throw where(`file ${name} is not in the manifest`);
		if (sha256Hex(data) !== want) throw where(`file ${name}: sha256 mismatch`);
	}
	for (const name of Object.keys(manifest.files))
		if (!files.has(name)) throw where(`file ${name} is missing`);

	if (manifest.os !== "linux" || manifest.arch !== "amd64")
		throw where(
			`package is for ${manifest.os}/${manifest.arch}, want linux/amd64`,
		);
	return {
		version: manifest.version,
		os: manifest.os,
		arch: manifest.arch,
		sha256: sha256Hex(tar),
	};
}
