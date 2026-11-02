// SSH keys for tests, built with node:crypto (no ssh-keygen): user public
// keys in the `authorized_keys` line format and an ed25519 login CA.
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { loadSshCa, type SshCa } from "@umiak/auth";

function str(b: Buffer | string): Buffer {
	const v = typeof b === "string" ? Buffer.from(b) : b;
	const len = Buffer.alloc(4);
	len.writeUInt32BE(v.length);
	return Buffer.concat([len, v]);
}

/** RFC 4251 mpint of an unsigned big-endian number. */
function mpint(b: Buffer): Buffer {
	let v = b;
	while (v.length > 1 && v[0] === 0) v = v.subarray(1);
	if ((v[0] ?? 0) & 0x80) v = Buffer.concat([Buffer.alloc(1), v]);
	return str(v);
}

function jwk(k: KeyObject): Record<string, string> {
	return k.export({ format: "jwk" }) as Record<string, string>;
}

const b64u = (s: string | undefined) => Buffer.from(s ?? "", "base64url");

/** A fresh `ssh-ed25519 AAAA... <comment>` line. */
export function ed25519PublicKey(comment = "me@laptop"): string {
	const { publicKey } = generateKeyPairSync("ed25519");
	const blob = Buffer.concat([str("ssh-ed25519"), str(b64u(jwk(publicKey).x))]);
	return `ssh-ed25519 ${blob.toString("base64")} ${comment}`;
}

/** A fresh `ssh-rsa` line of this modulus size. */
export function rsaPublicKey(bits: number): string {
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
	const k = jwk(publicKey);
	const blob = Buffer.concat([
		str("ssh-rsa"),
		mpint(b64u(k.e)),
		mpint(b64u(k.n)),
	]);
	return `ssh-rsa ${blob.toString("base64")}`;
}

/** A fresh `ecdsa-sha2-nistp256` line. */
export function ecdsaP256PublicKey(): string {
	const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const k = jwk(publicKey);
	const point = Buffer.concat([Buffer.from([4]), b64u(k.x), b64u(k.y)]);
	const blob = Buffer.concat([
		str("ecdsa-sha2-nistp256"),
		str("nistp256"),
		str(point),
	]);
	return `ecdsa-sha2-nistp256 ${blob.toString("base64")}`;
}

/** A fresh ed25519 SSH login CA. */
export function testSshCa(): SshCa {
	const { privateKey } = generateKeyPairSync("ed25519");
	return loadSshCa(
		privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
	);
}

/** "<type> <base64>" of a key line (without the comment). */
export function bareKey(line: string): string {
	return line.split(" ").slice(0, 2).join(" ");
}
