import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { captureSourceFile, writeSourceLayout } from "./source-artifact.mjs";

const exec = promisify(execFile);
const sha = (b) => createHash("sha256").update(b).digest("hex");
test("rawFetch preserves a gzip file even when its server adds Content-Encoding: gzip", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-source-encoding-"));
	let server;
	try {
		const key = join(dir, "key.pem"),
			cert = join(dir, "cert.pem");
		await exec("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-keyout",
			key,
			"-out",
			cert,
		]);
		const original = Buffer.from("original corresponding-source patch\n"),
			compressed = gzipSync(original);
		const encodings = [];
		server = createServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			(req, res) => {
				encodings.push(req.headers["accept-encoding"]);
				res.writeHead(200, {
					"Content-Type": "application/gzip",
					"Content-Encoding": "gzip",
					"Content-Length": compressed.length,
				});
				res.end(compressed);
			},
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		// Trust the disposable local CA only in the child, without disabling TLS checks.
		await exec(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { rawFetch } = await import(process.argv[1]);
const url = process.argv[2];
const raw = await rawFetch(url);
assert.equal(raw.headers.get("content-encoding"), "gzip");
const bytes = Buffer.from(await raw.arrayBuffer());
assert.equal(bytes.length, Number(process.argv[3]));
assert.equal(createHash("sha256").update(bytes).digest("hex"), process.argv[4]);
// Prove the same endpoint reproduces the global fetch transformation.
const decoded = Buffer.from(await (await fetch(url)).arrayBuffer());
assert.equal(createHash("sha256").update(decoded).digest("hex"), process.argv[5]);
assert.notDeepEqual(decoded, bytes);
`,
				new URL("./source-artifact.mjs", import.meta.url).href,
				`https://127.0.0.1:${server.address().port}/source.diff.gz`,
				String(compressed.length),
				sha(compressed),
				sha(original),
			],
			{ env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 15000 },
		);
		assert.equal(encodings[0], "identity");
		assert.equal(encodings.length, 2);
	} finally {
		if (server) {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
		await rm(dir, { recursive: true, force: true });
	}
});
test("source files split at stable boundaries and cached chunks are re-verified without re-downloading", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-source-chunks-"));
	try {
		const body = Buffer.from("unchanged source bytes");
		let downloads = 0;
		const options = {
			url: "https://sources.invalid/source.tar.xz",
			sha256: sha(body),
			sizeBytes: body.length,
			cache: dir,
			chunkBytes: 7,
			fetcher: async () => {
				downloads++;
				return new Response(body);
			},
		};
		const a = await captureSourceFile(options),
			b = await captureSourceFile(options);
		assert.deepEqual(a, b);
		assert.equal(downloads, 1);
		assert.equal(a.chunks.length, 4);
		const layout = join(dir, "layout");
		const result = await writeSourceLayout({
			directory: layout,
			cache: dir,
			version: "20261106.1",
			slug: "linux",
			sourceCommit: "b".repeat(40),
			files: [{ ...a, path: "pool/source.tar.xz" }],
			mapping: [
				{ binarySha256: "c".repeat(64), sources: ["pool/source.tar.xz"] },
			],
		});
		const manifest = await readFile(
			join(layout, "blobs/sha256", result.digest.slice(7)),
		);
		assert.equal(sha(manifest), result.digest.slice(7));
		assert.equal(
			JSON.parse(manifest).artifactType,
			"application/vnd.umiak.linux-sources.v1",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("source capture rejects altered size/hash before a companion can be published", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-source-tamper-"));
	try {
		await assert.rejects(
			captureSourceFile({
				url: "https://sources.invalid/source.dsc",
				sha256: "a".repeat(64),
				sizeBytes: 1,
				cache: dir,
				fetcher: async () => new Response("x"),
				wait: async () => {},
			}),
			/hash|checksum/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
