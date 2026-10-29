import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	loadSshCa,
	loadSshHostKeys,
	parseSshPublicKey,
	parseUserCertificate,
	type SshCa,
	SshKeyError,
	signUserCertificate,
} from "../src/index.ts";

const hasKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

function keygen(args: string[]): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const r = spawnSync("ssh-keygen", args, { encoding: "utf8" });
	return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

function mustKeygen(args: string[]): string {
	const r = keygen(args);
	if (r.status !== 0)
		throw new Error(`ssh-keygen ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

function reasonOf(fn: () => unknown): string {
	try {
		fn();
	} catch (e) {
		if (e instanceof SshKeyError) return e.reason;
		throw e;
	}
	throw new Error("expected SshKeyError");
}

// Minimal SSH wire helpers to build odd blobs by hand.
function str(b: Buffer | string): Buffer {
	const v = typeof b === "string" ? Buffer.from(b) : b;
	const len = Buffer.alloc(4);
	len.writeUInt32BE(v.length);
	return Buffer.concat([len, v]);
}

/** "<type> <base64>" without the comment. */
function bare(l: string): string {
	return l.split(" ").slice(0, 2).join(" ");
}

function line(type: string, blob: Buffer, comment?: string): string {
	return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`;
}

const NOW = new Date("2026-10-30T12:00:00Z");
const AFTER = new Date(NOW.getTime() - 60_000);
const BEFORE = new Date(NOW.getTime() + 600_000);
const KEY_ID = "sbx:user:usr_01j8zq4w7k3m5n6p7q8r9s0t1v";
const PRINCIPAL = "sb_01j8zq4w7k3m5n6p7q8r9s0t1v";
const EXTENSIONS = [
	"permit-X11-forwarding",
	"permit-agent-forwarding",
	"permit-port-forwarding",
	"permit-pty",
	"permit-user-rc",
];

describe("parseSshPublicKey (hand-built input)", () => {
	const ed = Buffer.alloc(32, 7);
	const edLine = line(
		"ssh-ed25519",
		Buffer.concat([str("ssh-ed25519"), str(ed)]),
		"me@host",
	);

	it("parses an ed25519 key and computes the fingerprint", () => {
		const k = parseSshPublicKey(edLine);
		expect(k.type).toBe("ssh-ed25519");
		expect(k.comment).toBe("me@host");
		const blob = Buffer.concat([str("ssh-ed25519"), str(ed)]);
		expect(k.blob.equals(blob)).toBe(true);
		const fp = createHash("sha256")
			.update(blob)
			.digest("base64")
			.replace(/=+$/, "");
		expect(k.fingerprint).toBe(`SHA256:${fp}`);
		expect(k.fingerprint).not.toContain("=");
	});

	it("keeps a multi-word comment, null without one, tolerates surrounding space", () => {
		expect(parseSshPublicKey(`${edLine} two words`).comment).toBe(
			"me@host two words",
		);
		const [t, b] = edLine.split(" ");
		expect(parseSshPublicKey(`  ${t}   ${b}\n`).comment).toBeNull();
	});

	it("rejects DSA and security-key types", () => {
		const dss = Buffer.concat([
			str("ssh-dss"),
			str(Buffer.alloc(129, 1)),
			str(Buffer.alloc(21, 1)),
			str(Buffer.alloc(128, 1)),
			str(Buffer.alloc(128, 1)),
		]);
		expect(reasonOf(() => parseSshPublicKey(line("ssh-dss", dss)))).toBe(
			"unsupported_type",
		);
		const sk = Buffer.concat([
			str("sk-ssh-ed25519@openssh.com"),
			str(ed),
			str("ssh:"),
		]);
		expect(
			reasonOf(() => parseSshPublicKey(line("sk-ssh-ed25519@openssh.com", sk))),
		).toBe("unsupported_type");
		expect(
			reasonOf(() =>
				parseSshPublicKey(line("sk-ecdsa-sha2-nistp256@openssh.com", sk)),
			),
		).toBe("unsupported_type");
		expect(reasonOf(() => parseSshPublicKey(line("foo", sk)))).toBe(
			"unsupported_type",
		);
	});

	it("rejects any certificate type", () => {
		for (const t of [
			"ssh-ed25519-cert-v01@openssh.com",
			"ssh-rsa-cert-v01@openssh.com",
			"ecdsa-sha2-nistp256-cert-v01@openssh.com",
		]) {
			expect(
				reasonOf(() =>
					parseSshPublicKey(line(t, Buffer.concat([str(t), str(ed)]))),
				),
			).toBe("certificate");
		}
	});

	it("rejects malformed input", () => {
		const good = Buffer.concat([str("ssh-ed25519"), str(ed)]);
		const cases = [
			"",
			"ssh-ed25519",
			"ssh-ed25519 !!!notbase64",
			"ssh-ed25519 AAAA=x",
			`${edLine}\nssh-ed25519 ${good.toString("base64")}`,
			line("ssh-ed25519", Buffer.concat([str("ssh-rsa"), str(ed)])), // inner type differs
			line(
				"ssh-ed25519",
				Buffer.concat([str("ssh-ed25519"), str(Buffer.alloc(31))]),
			), // short key
			line("ssh-ed25519", Buffer.concat([good, Buffer.from([0])])), // trailing bytes
			line("ssh-ed25519", good.subarray(0, good.length - 1)), // truncated
			line(
				"ssh-ed25519",
				Buffer.concat([
					str("ssh-ed25519"),
					Buffer.from([0xff, 0xff, 0xff, 0xff]),
				]),
			), // huge length
		];
		for (const c of cases)
			expect(
				reasonOf(() => parseSshPublicKey(c)),
				c.slice(0, 60),
			).toBe("malformed");
	});

	it("rejects a valid key padded past the line cap", () => {
		const long = `${edLine} ${"x".repeat(17_000)}`;
		expect(reasonOf(() => parseSshPublicKey(long))).toBe("malformed");
		expect(() => parseSshPublicKey(long)).toThrow(/too long/);
	});

	it("rejects control characters in the comment", () => {
		for (const c of ["\x1b[31mred", "a\x00b", "a\tb", "a\x7fb", "a\rb"]) {
			expect(
				reasonOf(() => parseSshPublicKey(`${edLine}${c}`)),
				JSON.stringify(c),
			).toBe("malformed");
		}
		expect(parseSshPublicKey(`${edLine} ünïcode ok`).comment).toBe(
			"me@host ünïcode ok",
		);
	});

	it("requires canonical RSA mpints and OpenSSH/Go size limits", () => {
		const jwk = generateKeyPairSync("rsa", {
			modulusLength: 3072,
		}).publicKey.export({ format: "jwk" });
		const n = Buffer.from(jwk.n as string, "base64url");
		const e = Buffer.from(jwk.e as string, "base64url");
		// Minimal mpint: positive, leading 0x00 only before a byte with the high bit set.
		const mp = (b: Buffer): Buffer =>
			(b[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
		const rsa = (eb: Buffer, nb: Buffer): string =>
			line("ssh-rsa", Buffer.concat([str("ssh-rsa"), str(eb), str(nb)]));
		const ok = parseSshPublicKey(rsa(mp(e), mp(n)));
		expect(ok.type).toBe("ssh-rsa");
		// Same as the fingerprint Go/OpenSSH compute after re-encoding.
		expect(
			ok.blob.equals(Buffer.concat([str("ssh-rsa"), str(mp(e)), str(mp(n))])),
		).toBe(true);

		const bad: [string, string][] = [
			["padded modulus", rsa(mp(e), Buffer.concat([Buffer.from([0]), mp(n)]))],
			["padded exponent", rsa(Buffer.concat([Buffer.from([0]), e]), mp(n))],
			["modulus missing sign byte", rsa(mp(e), n)],
			["zero exponent as 00", rsa(Buffer.from([0]), mp(n))],
			["empty exponent", rsa(Buffer.alloc(0), mp(n))],
			["even exponent", rsa(Buffer.from([0x01, 0x00, 0x00]), mp(n))],
			["exponent 1", rsa(Buffer.from([1]), mp(n))],
			// 25-bit exponent 0x01000001.
			["25-bit exponent", rsa(Buffer.from([0x01, 0x00, 0x00, 0x01]), mp(n))],
			// 16385-bit modulus: 0x01 followed by 2048 bytes.
			[
				"16385-bit modulus",
				rsa(
					mp(e),
					Buffer.concat([Buffer.from([0x01]), Buffer.alloc(2048, 0xff)]),
				),
			],
		];
		for (const [what, l] of bad)
			expect(
				reasonOf(() => parseSshPublicKey(l)),
				what,
			).toBe("malformed");

		// Boundaries that must pass: 24-bit exponent, 16384-bit modulus.
		expect(
			parseSshPublicKey(rsa(Buffer.from([0, 0xff, 0xff, 0xff]), mp(n))).type,
		).toBe("ssh-rsa");
		const n16384 = Buffer.concat([
			Buffer.from([0x00, 0x80]),
			Buffer.alloc(2047, 0xff),
		]);
		expect(parseSshPublicKey(rsa(mp(e), n16384)).type).toBe("ssh-rsa");
	});

	it("rejects an ECDSA point that is not on the curve", () => {
		const q = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
		const blob = Buffer.concat([
			str("ecdsa-sha2-nistp256"),
			str("nistp256"),
			str(q),
		]);
		expect(
			reasonOf(() => parseSshPublicKey(line("ecdsa-sha2-nistp256", blob))),
		).toBe("malformed");
	});

	it("rejects an ECDSA curve name that does not match the type", () => {
		const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const jwk = publicKey.export({ format: "jwk" });
		const q = Buffer.concat([
			Buffer.from([4]),
			Buffer.from(jwk.x as string, "base64url"),
			Buffer.from(jwk.y as string, "base64url"),
		]);
		const ok = Buffer.concat([
			str("ecdsa-sha2-nistp256"),
			str("nistp256"),
			str(q),
		]);
		expect(parseSshPublicKey(line("ecdsa-sha2-nistp256", ok)).type).toBe(
			"ecdsa-sha2-nistp256",
		);
		const bad = Buffer.concat([
			str("ecdsa-sha2-nistp256"),
			str("nistp384"),
			str(q),
		]);
		expect(
			reasonOf(() => parseSshPublicKey(line("ecdsa-sha2-nistp256", bad))),
		).toBe("malformed");
	});
});

describe("loadSshCa (no ssh-keygen)", () => {
	it("loads a PKCS#8 PEM ed25519 key", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const ca = loadSshCa(
			privateKey.export({ format: "pem", type: "pkcs8" }) as string,
		);
		expect(ca.publicKey).toMatch(
			/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=*$/,
		);
		expect(parseSshPublicKey(ca.publicKey).fingerprint).toBe(ca.fingerprint);
	});

	it("rejects non-ed25519 PEM keys and garbage", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		expect(
			reasonOf(() =>
				loadSshCa(
					privateKey.export({ format: "pem", type: "pkcs8" }) as string,
				),
			),
		).toBe("unsupported_type");
		expect(reasonOf(() => loadSshCa("not a key"))).toBe("malformed");
	});

	it("does not expose the private key when serialized", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
		const ca = loadSshCa(pem);
		const d = privateKey.export({ format: "jwk" }).d as string;
		const dump = `${JSON.stringify(ca)} ${String(ca)}`;
		expect(dump).not.toContain(d);
		expect(dump).not.toContain(pem.split("\n")[1]);
	});
});

describe("signUserCertificate input checks (no ssh-keygen)", () => {
	const { privateKey } = generateKeyPairSync("ed25519");
	const ca = loadSshCa(
		privateKey.export({ format: "pem", type: "pkcs8" }) as string,
	);
	const user = loadSshCa(
		generateKeyPairSync("ed25519").privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string,
	).publicKey;
	const base = {
		publicKey: user,
		keyId: KEY_ID,
		principals: [PRINCIPAL],
		validAfter: AFTER,
		validBefore: BEFORE,
	};

	it("round-trips through parseUserCertificate", () => {
		const { certificate, serial } = signUserCertificate(ca, {
			...base,
			serial: 42n,
		});
		expect(serial).toBe(42n);
		expect(
			certificate.startsWith("ssh-ed25519-cert-v01@openssh.com AAAA"),
		).toBe(true);
		expect(certificate.endsWith(` ${KEY_ID}`)).toBe(true);
		const c = parseUserCertificate(certificate);
		expect(c).toMatchObject({
			keyId: KEY_ID,
			principals: [PRINCIPAL],
			serial: 42n,
			signatureKey: ca.publicKey,
			publicKey: user,
			type: "ssh-ed25519-cert-v01@openssh.com",
			criticalOptions: [],
			extensions: EXTENSIONS,
		});
		expect(c.validAfter.toISOString()).toBe(AFTER.toISOString());
		expect(c.validBefore.toISOString()).toBe(BEFORE.toISOString());
	});

	it("uses a random 64-bit serial by default", () => {
		const a = signUserCertificate(ca, base).serial;
		const b = signUserCertificate(ca, base).serial;
		expect(a).not.toBe(b);
		for (const s of [a, b]) {
			expect(s >= 0n && s < 1n << 64n).toBe(true);
		}
	});

	it("floors sub-second times", () => {
		const c = parseUserCertificate(
			signUserCertificate(ca, {
				...base,
				validAfter: new Date(AFTER.getTime() + 999),
			}).certificate,
		);
		expect(c.validAfter.toISOString()).toBe(AFTER.toISOString());
	});

	it("rejects bad input", () => {
		expect(() => signUserCertificate(ca, { ...base, principals: [] })).toThrow(
			RangeError,
		);
		expect(() => signUserCertificate(ca, { ...base, keyId: "" })).toThrow(
			RangeError,
		);
		for (const bad of ["sbx:user x", "a\nb", "a\x00b", "a\tb", "a\x7fb"]) {
			expect(
				() => signUserCertificate(ca, { ...base, keyId: bad }),
				JSON.stringify(bad),
			).toThrow(RangeError);
			expect(
				() => signUserCertificate(ca, { ...base, principals: [bad] }),
				JSON.stringify(bad),
			).toThrow(RangeError);
		}
		expect(() =>
			signUserCertificate(ca, { ...base, validBefore: AFTER }),
		).toThrow(RangeError);
		expect(() => signUserCertificate(ca, { ...base, serial: -1n })).toThrow(
			RangeError,
		);
		expect(() =>
			signUserCertificate(ca, { ...base, serial: 1n << 64n }),
		).toThrow(RangeError);
		expect(
			reasonOf(() => signUserCertificate(ca, { ...base, publicKey: "nope" })),
		).toBe("malformed");
	});

	it("rejects a tampered body, a foreign signature and a public key", () => {
		const { certificate } = signUserCertificate(ca, base);
		const [t, b64] = certificate.split(" ") as [string, string];
		const blob = Buffer.from(b64, "base64");
		const at = blob.indexOf(Buffer.from(PRINCIPAL));
		blob[at + 3] = (blob[at + 3] as number) ^ 1;
		expect(
			reasonOf(() => parseUserCertificate(`${t} ${blob.toString("base64")}`)),
		).toBe("bad_signature");
		const sig = Buffer.from(b64, "base64");
		sig[sig.length - 1] = (sig[sig.length - 1] as number) ^ 1;
		expect(
			reasonOf(() => parseUserCertificate(`${t} ${sig.toString("base64")}`)),
		).toBe("bad_signature");
		expect(reasonOf(() => parseUserCertificate(user))).toBe("malformed");
		expect(
			reasonOf(() =>
				parseUserCertificate(
					`${t} ${Buffer.from(b64, "base64").subarray(0, 100).toString("base64")}`,
				),
			),
		).toBe("malformed");
	});
});

describe("loadSshHostKeys", () => {
	const a = loadSshCa(
		generateKeyPairSync("ed25519").privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string,
	).publicKey;
	const b = loadSshCa(
		generateKeyPairSync("ed25519").privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string,
	).publicKey;

	it("returns public key lines without comments, skipping blanks and # lines", () => {
		expect(
			loadSshHostKeys(`# gateway host keys\n${a} root@gw\n\n  ${b}\r\n`),
		).toEqual([a, b]);
		expect(loadSshHostKeys("")).toEqual([]);
	});

	it("rejects private keys and invalid lines", () => {
		const pem = generateKeyPairSync("ed25519").privateKey.export({
			format: "pem",
			type: "pkcs8",
		}) as string;
		expect(reasonOf(() => loadSshHostKeys(`${a}\n${pem}`))).toBe("private_key");
		expect(
			reasonOf(() =>
				loadSshHostKeys(
					"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
				),
			),
		).toBe("private_key");
		expect(reasonOf(() => loadSshHostKeys(`${a}\ngarbage`))).toBe("malformed");
	});
});

describe.skipIf(!hasKeygen)("with ssh-keygen", () => {
	let dir = "";
	const keys: Record<string, { path: string; line: string }> = {};
	let ca: SshCa;
	let caPub = "";
	const key = (name: string): { path: string; line: string } => {
		const k = keys[name];
		if (!k) throw new Error(`no test key ${name}`);
		return k;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "sbx-ssh-test-"));
		const specs: Record<string, string[]> = {
			ed25519: ["-t", "ed25519"],
			ecdsa256: ["-t", "ecdsa", "-b", "256"],
			ecdsa384: ["-t", "ecdsa", "-b", "384"],
			ecdsa521: ["-t", "ecdsa", "-b", "521"],
			rsa3072: ["-t", "rsa", "-b", "3072"],
			rsa2048: ["-t", "rsa", "-b", "2048"],
			ca: ["-t", "ed25519"],
			caEnc: ["-t", "ed25519"],
			caEcdsa: ["-t", "ecdsa", "-b", "256"],
		};
		for (const [name, args] of Object.entries(specs)) {
			const path = join(dir, name);
			const pass = name === "caEnc" ? "secret-pass" : "";
			mustKeygen([...args, "-q", "-N", pass, "-C", `${name}@test`, "-f", path]);
			keys[name] = { path, line: readFileSync(`${path}.pub`, "utf8").trim() };
		}
		ca = loadSshCa(readFileSync(join(dir, "ca"), "utf8"));
		caPub = key("ca").line;
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	const accepted: [string, string][] = [
		["ed25519", "ssh-ed25519"],
		["ecdsa256", "ecdsa-sha2-nistp256"],
		["ecdsa384", "ecdsa-sha2-nistp384"],
		["ecdsa521", "ecdsa-sha2-nistp521"],
		["rsa3072", "ssh-rsa"],
	];

	it.each(accepted)("parses %s and matches ssh-keygen -lf", (name, type) => {
		const k = key(name);
		const parsed = parseSshPublicKey(k.line);
		expect(parsed.type).toBe(type);
		expect(parsed.comment).toBe(`${name}@test`);
		const out = mustKeygen(["-l", "-E", "sha256", "-f", `${k.path}.pub`]);
		expect(out.split(" ")[1]).toBe(parsed.fingerprint);
	});

	it("rejects RSA 2048", () => {
		expect(reasonOf(() => parseSshPublicKey(key("rsa2048").line))).toBe(
			"rsa_too_short",
		);
	});

	it("rejects a certificate made by ssh-keygen", () => {
		mustKeygen([
			"-q",
			"-s",
			key("ca").path,
			"-I",
			"x",
			"-n",
			"p",
			`${key("ed25519").path}.pub`,
		]);
		const cert = readFileSync(`${key("ed25519").path}-cert.pub`, "utf8");
		expect(reasonOf(() => parseSshPublicKey(cert))).toBe("certificate");
		// The other direction: our parser reads and verifies a certificate made by OpenSSH.
		const c = parseUserCertificate(cert);
		expect(c).toMatchObject({
			keyId: "x",
			principals: ["p"],
			signatureKey: bare(caPub),
			publicKey: bare(key("ed25519").line),
		});
		expect(c.extensions).toEqual(EXTENSIONS);
	});

	it("loads the OpenSSH CA key; public key equals ssh-keygen's .pub", () => {
		expect(ca.publicKey).toBe(bare(caPub));
	});

	it("rejects an encrypted OpenSSH key and a non-ed25519 OpenSSH key", () => {
		expect(
			reasonOf(() => loadSshCa(readFileSync(key("caEnc").path, "utf8"))),
		).toBe("encrypted");
		expect(
			reasonOf(() => loadSshCa(readFileSync(key("caEcdsa").path, "utf8"))),
		).toBe("unsupported_type");
	});

	it("rejects OpenSSH private keys in the host keys file", () => {
		expect(
			reasonOf(() => loadSshHostKeys(readFileSync(key("ca").path, "utf8"))),
		).toBe("private_key");
		const file = `${key("ed25519").line}\n${key("ecdsa256").line}\n`;
		expect(loadSshHostKeys(file)).toEqual([
			bare(key("ed25519").line),
			bare(key("ecdsa256").line),
		]);
	});

	it.each(accepted)(
		"signs a %s user certificate that ssh-keygen -L accepts",
		(name, type) => {
			const k = key(name);
			const { certificate, serial } = signUserCertificate(ca, {
				publicKey: k.line,
				keyId: KEY_ID,
				principals: [PRINCIPAL],
				validAfter: AFTER,
				validBefore: BEFORE,
			});
			const certPath = join(dir, `${name}-signed-cert.pub`);
			writeFileSync(certPath, `${certificate}\n`);
			const r = keygen(["-L", "-f", certPath]);
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain(
				`Type: ${type}-cert-v01@openssh.com user certificate`,
			);
			expect(r.stdout).toContain(`Key ID: "${KEY_ID}"`);
			expect(r.stdout).toContain(`Serial: ${serial}`);
			expect(r.stdout).toMatch(
				new RegExp(`Principals: \\n\\s+${PRINCIPAL}\\n`),
			);
			expect(r.stdout).toMatch(/Valid: from \S+ to \S+/);
			expect(r.stdout).toContain(`Signing CA: ED25519 ${ca.fingerprint}`);
			expect(r.stdout).toContain(
				`Public key: ${type.startsWith("ecdsa") ? "ECDSA" : type === "ssh-rsa" ? "RSA" : "ED25519"}-CERT ${parseSshPublicKey(k.line).fingerprint}`,
			);
			expect(r.stdout).toMatch(/Critical Options: \(none\)/);
			const ext = r.stdout.split("Extensions:")[1]?.trim().split(/\s+/);
			expect(ext).toEqual(EXTENSIONS);
			const parsed = parseUserCertificate(certificate);
			expect(parsed.serial).toBe(serial);
			expect(parsed.publicKey).toBe(bare(k.line));
		},
	);

	it("ssh-keygen -L rejects a tampered certificate", () => {
		const { certificate } = signUserCertificate(ca, {
			publicKey: key("ed25519").line,
			keyId: KEY_ID,
			principals: [PRINCIPAL],
			validAfter: AFTER,
			validBefore: BEFORE,
		});
		const [t, b64] = certificate.split(" ") as [string, string];
		const blob = Buffer.from(b64, "base64");
		const at = blob.indexOf(Buffer.from(KEY_ID));
		blob[at] = (blob[at] as number) ^ 1;
		const certPath = join(dir, "tampered-cert.pub");
		writeFileSync(certPath, `${t} ${blob.toString("base64")}\n`);
		expect(keygen(["-L", "-f", certPath]).status).not.toBe(0);
		expect(
			reasonOf(() => parseUserCertificate(`${t} ${blob.toString("base64")}`)),
		).toBe("bad_signature");
	});
});
