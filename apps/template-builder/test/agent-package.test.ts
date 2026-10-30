import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAgentPackage } from "../src/agent-package.ts";
import { readTar } from "../src/tar.ts";

const fixtures = resolve(import.meta.dirname, "fixtures/agent");

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "sbx-agent-pkg-test-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0))
		rmSync(d, { recursive: true, force: true });
});

interface TarEntry {
	name: string;
	data?: Buffer;
	type?: string;
	/** Size written to the header; defaults to the data length. */
	size?: number;
	/** Written at offset 257 (8 bytes); defaults to the ustar magic and version. */
	magic?: string;
}

/** Minimal ustar writer for tests. */
function makeTar(entries: TarEntry[], end = Buffer.alloc(1024)): Buffer {
	const blocks: Buffer[] = [];
	for (const e of entries) {
		const data = e.data ?? Buffer.alloc(0);
		const hdr = Buffer.alloc(512);
		hdr.write(e.name, 0, 100, "utf8");
		hdr.write("0000644\0", 100);
		hdr.write("0000000\0", 108);
		hdr.write("0000000\0", 116);
		hdr.write(
			`${(e.size ?? data.length).toString(8).padStart(11, "0")}\0`,
			124,
		);
		hdr.write("00000000000\0", 136);
		hdr.write("        ", 148);
		hdr.write(e.type ?? "0", 156);
		hdr.write(e.magic ?? "ustar\x0000", 257, "latin1");
		let sum = 0;
		for (const b of hdr) sum += b;
		hdr.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(hdr, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(end);
	return Buffer.concat(blocks);
}

const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");

interface Key {
	priv: KeyObject;
	line: string;
}
function newKey(comment = "test"): Key {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const raw = Buffer.from(
		publicKey.export({ format: "jwk" }).x as string,
		"base64url",
	);
	return {
		priv: privateKey,
		line: `ed25519 ${raw.toString("base64")} ${comment}`,
	};
}

interface PackOpts {
	key: Key;
	os?: string;
	arch?: string;
	version?: string;
	/** Applied to the manifest object before signing. */
	mutate?: (m: Record<string, unknown>) => void;
	/** Applied to the package files after the manifest is built. */
	files?: (f: Record<string, Buffer>) => void;
	extra?: TarEntry[];
	sigLength?: number;
}

function buildPackage(o: PackOpts): Buffer {
	const files: Record<string, Buffer> = {
		"sbx-agent": Buffer.from("agent binary"),
		"trust/tunnel-ca.pem": Buffer.from("ca"),
		"trust/update-keys.pub": Buffer.from(`${o.key.line}\n`),
	};
	const manifest: Record<string, unknown> = {
		format: "sbx-agent-manifest/v1",
		version: o.version ?? "1.2.3",
		os: o.os ?? "linux",
		arch: o.arch ?? "amd64",
		files: Object.fromEntries(
			Object.entries(files).map(([n, d]) => [n, sha(d)]),
		),
		created_at: "2026-10-30T00:00:00Z",
	};
	o.mutate?.(manifest);
	o.files?.(files);
	const mbytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
	const sig = sign(null, mbytes, o.key.priv);
	return makeTar([
		{ name: "trust/", type: "5" },
		...Object.entries(files).map(([name, data]) => ({ name, data })),
		{ name: "manifest.json", data: mbytes },
		{ name: "manifest.sig", data: sig.subarray(0, o.sigLength ?? 64) },
		...(o.extra ?? []),
	]);
}

function write(dir: string, tar: Buffer, keys: string): [string, string] {
	const tarPath = join(dir, "pkg.tar");
	const keysPath = join(dir, "update-keys.pub");
	writeFileSync(tarPath, tar);
	writeFileSync(keysPath, keys);
	return [tarPath, keysPath];
}

describe("readTar", () => {
	it("returns regular files and accepts directory entries", () => {
		const m = readTar(
			makeTar([
				{ name: "trust/", type: "5" },
				{ name: "trust/a.txt", data: Buffer.from("hello") },
				{ name: "./b.txt", data: Buffer.alloc(600, 1) },
			]),
		);
		expect([...m.keys()]).toEqual(["trust/a.txt", "b.txt"]);
		expect(m.get("trust/a.txt")?.toString()).toBe("hello");
		expect(m.get("b.txt")?.length).toBe(600);
	});

	it("rejects '..' and absolute names", () => {
		for (const name of ["../evil", "a/../../evil", "/etc/passwd"])
			expect(() =>
				readTar(makeTar([{ name, data: Buffer.from("x") }])),
			).toThrow(/entry/);
		expect(() => readTar(makeTar([{ name: "../d/", type: "5" }]))).toThrow(
			/entry/,
		);
	});

	it("accepts trailing zero padding after the end blocks", () => {
		const m = readTar(
			makeTar([{ name: "a", data: Buffer.from("1") }], Buffer.alloc(10240)),
		);
		expect([...m.keys()]).toEqual(["a"]);
	});

	// Go's tar.Reader and GNU tar skip no data after a directory header, so
	// the hidden entry below would be extracted as sbx-agent by `tar -x`.
	it("rejects a directory entry that carries data (hidden entry)", () => {
		const hidden = makeTar([{ name: "sbx-agent", data: Buffer.from("evil") }]);
		const body = hidden.subarray(0, 1024);
		expect(() =>
			readTar(
				makeTar([
					{ name: "trust/", type: "5", size: body.length, data: body },
					{ name: "sbx-agent", data: Buffer.from("signed") },
				]),
			),
		).toThrow(/directory .* has data/);
		expect(() =>
			readTar(makeTar([{ name: "trust/", type: "5", size: 1 }])),
		).toThrow(/has data/);
	});

	it("rejects pax and GNU long-name headers", () => {
		for (const type of ["g", "x", "L", "K"])
			expect(() =>
				readTar(
					makeTar([
						{ name: "hdr", type, data: Buffer.from("15 path=evil\n") },
						{ name: "a", data: Buffer.from("1") },
					]),
				),
			).toThrow(/unsupported type/);
	});

	it("requires the ustar magic and version", () => {
		for (const magic of [
			"ustar  \0",
			"ustar\x0001",
			"\0\0\0\0\0\0\0\0",
			"USTAR\x0000",
		])
			expect(() =>
				readTar(makeTar([{ name: "a", data: Buffer.from("1"), magic }])),
			).toThrow(/not a ustar header/);
	});

	it("rejects a regular entry whose name ends in '/'", () => {
		for (const type of ["0", "\0"])
			expect(() =>
				readTar(makeTar([{ name: "trust/", type, data: Buffer.from("x") }])),
			).toThrow(/bad entry name/);
	});

	it("requires two zero blocks and only zeros after them", () => {
		const entries = [{ name: "a", data: Buffer.from("1") }];
		expect(() => readTar(makeTar(entries, Buffer.alloc(0)))).toThrow(
			/truncated/,
		);
		expect(() => readTar(makeTar(entries, Buffer.alloc(512)))).toThrow(
			/truncated/,
		);
		const late = makeTar(entries, Buffer.alloc(1024 + 512));
		late[late.length - 1] = 1;
		expect(() => readTar(late)).toThrow(/after the end/);
		// A complete entry after the end blocks must not be reachable.
		const tail = makeTar([{ name: "sbx-agent", data: Buffer.from("evil") }]);
		expect(() =>
			readTar(Buffer.concat([makeTar(entries, Buffer.alloc(1024)), tail])),
		).toThrow(/after the end/);
	});

	it("rejects links, duplicates and corrupt headers", () => {
		expect(() => readTar(makeTar([{ name: "l", type: "2" }]))).toThrow(
			/unsupported type/,
		);
		expect(() =>
			readTar(
				makeTar([
					{ name: "a", data: Buffer.from("1") },
					{ name: "a", data: Buffer.from("2") },
				]),
			),
		).toThrow(/duplicate/);
		const bad = makeTar([{ name: "a", data: Buffer.from("1") }]);
		bad[0] = bad[0] === 0x62 ? 0x63 : 0x62;
		expect(() => readTar(bad)).toThrow(/checksum/);
		const truncated = makeTar([{ name: "a", data: Buffer.alloc(1000) }]);
		expect(() => readTar(truncated.subarray(0, 700))).toThrow(/truncated/);
	});
});

describe("verifyAgentPackage", () => {
	it("accepts a signed package and returns the tar sha256", () => {
		const key = newKey();
		const tar = buildPackage({ key });
		const [tarPath, keysPath] = write(tmp(), tar, `# keys\n\n${key.line}\n`);
		expect(verifyAgentPackage(tarPath, keysPath)).toEqual({
			version: "1.2.3",
			os: "linux",
			arch: "amd64",
			sha256: sha(tar),
		});
	});

	it("accepts a package signed by any listed key", () => {
		const a = newKey("a");
		const b = newKey("b");
		const [tarPath, keysPath] = write(
			tmp(),
			buildPackage({ key: b }),
			`${a.line}\n${b.line}\n`,
		);
		expect(verifyAgentPackage(tarPath, keysPath).version).toBe("1.2.3");
	});

	it("accepts a package built by sbx-release (Go)", () => {
		const r = verifyAgentPackage(
			join(fixtures, "sbx-agent-fixture.tar"),
			join(fixtures, "update-keys.pub"),
		);
		expect(r).toMatchObject({
			version: "0.0.0-fixture",
			os: "linux",
			arch: "amd64",
		});
		expect(r.sha256).toBe(
			sha(readFileSync(join(fixtures, "sbx-agent-fixture.tar"))),
		);
	});

	it("rejects a flipped byte in sbx-agent", () => {
		const key = newKey();
		const tar = buildPackage({ key });
		const at = tar.indexOf("agent binary");
		tar[at] = tar[at] === 0x61 ? 0x62 : 0x61;
		const [tarPath, keysPath] = write(tmp(), tar, key.line);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(
			/sha256 mismatch/,
		);
	});

	it("rejects a signature by an unlisted key", () => {
		const signer = newKey("signer");
		const other = newKey("other");
		const [tarPath, keysPath] = write(
			tmp(),
			buildPackage({ key: signer }),
			other.line,
		);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(
			/matches no trusted key/,
		);
	});

	it("rejects a manifest changed after signing", () => {
		const key = newKey();
		const tar = buildPackage({ key });
		const at = tar.indexOf('"1.2.3"') + 1;
		tar[at] = 0x39; // 1.2.3 -> 9.2.3
		const [tarPath, keysPath] = write(tmp(), tar, key.line);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(
			/matches no trusted key/,
		);
	});

	it("rejects a signature that is not 64 bytes", () => {
		const key = newKey();
		const [tarPath, keysPath] = write(
			tmp(),
			buildPackage({ key, sigLength: 63 }),
			key.line,
		);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(/64/);
	});

	it("rejects arch arm64 and os windows", () => {
		const key = newKey();
		const dir = tmp();
		const [arm, keysPath] = write(
			dir,
			buildPackage({ key, arch: "arm64" }),
			key.line,
		);
		expect(() => verifyAgentPackage(arm, keysPath)).toThrow(/linux\/amd64/);
		const [win] = write(dir, buildPackage({ key, os: "windows" }), key.line);
		expect(() => verifyAgentPackage(win, keysPath)).toThrow(/linux\/amd64/);
	});

	it("rejects a wrong manifest format and an invalid version", () => {
		const key = newKey();
		const dir = tmp();
		const [fmt, keysPath] = write(
			dir,
			buildPackage({
				key,
				mutate: (m) => (m.format = "sbx-agent-manifest/v2"),
			}),
			key.line,
		);
		expect(() => verifyAgentPackage(fmt, keysPath)).toThrow(/format/);
		const [ver] = write(dir, buildPackage({ key, version: "../1" }), key.line);
		expect(() => verifyAgentPackage(ver, keysPath)).toThrow(/version/);
	});

	it("rejects a listed file that is missing and a file that is not listed", () => {
		const key = newKey();
		const dir = tmp();
		const [missing, keysPath] = write(
			dir,
			buildPackage({ key, files: (f) => delete f["trust/tunnel-ca.pem"] }),
			key.line,
		);
		expect(() => verifyAgentPackage(missing, keysPath)).toThrow(/missing/);
		const [extra] = write(
			dir,
			buildPackage({
				key,
				extra: [{ name: "evil.sh", data: Buffer.from("x") }],
			}),
			key.line,
		);
		expect(() => verifyAgentPackage(extra, keysPath)).toThrow(
			/not in the manifest/,
		);
	});

	it("rejects a manifest without a required file", () => {
		const key = newKey();
		const [tarPath, keysPath] = write(
			tmp(),
			buildPackage({
				key,
				mutate: (m) => delete (m.files as Record<string, string>)["sbx-agent"],
			}),
			key.line,
		);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(/sbx-agent/);
	});

	it("rejects a package without manifest.sig", () => {
		const key = newKey();
		const tar = makeTar([{ name: "manifest.json", data: Buffer.from("{}") }]);
		const [tarPath, keysPath] = write(tmp(), tar, key.line);
		expect(() => verifyAgentPackage(tarPath, keysPath)).toThrow(
			/manifest\.sig/,
		);
	});

	it("rejects a malformed keys file", () => {
		const key = newKey();
		const dir = tmp();
		const tar = buildPackage({ key });
		const [tarPath, noKeys] = write(dir, tar, "# nothing\n");
		expect(() => verifyAgentPackage(tarPath, noKeys)).toThrow(/no keys/);
		const [, badKey] = write(dir, tar, "ed25519 AAAA bad\n");
		expect(() => verifyAgentPackage(tarPath, badKey)).toThrow(/32/);
		const lax = key.line.replace("=", "");
		const [, unpadded] = write(dir, tar, `${lax}\n`);
		expect(() => verifyAgentPackage(tarPath, unpadded)).toThrow(/base64/);
		const [, urlSafe] = write(
			dir,
			tar,
			`ed25519 ${"A".repeat(42)}-= url-safe\n`,
		);
		expect(() => verifyAgentPackage(tarPath, urlSafe)).toThrow(/base64/);
		const [, rsa] = write(dir, tar, "rsa AAAA bad\n");
		expect(() => verifyAgentPackage(tarPath, rsa)).toThrow(/ed25519/);
	});
});
