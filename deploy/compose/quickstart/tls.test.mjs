import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { quickstartTls } from "./tls.mjs";

const run = promisify(execFile);
const openssl = (command, args) => run("openssl", [command, ...args]);

test("unknown SNI is refused without consuming capacity for configured names", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-"));
	let server;
	try {
		const tls = await quickstartTls(dir, ["home.example.test"]);
		server = https.createServer(tls, (_req, res) => res.end("ok"));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const ca = await readFile(join(dir, "ca.pem"));
		const get = (servername) =>
			new Promise((resolve, reject) => {
				https
					.get(
						{ host: "127.0.0.1", port: server.address().port, servername, ca },
						(res) => {
							res.resume();
							resolve(res.statusCode);
						},
					)
					.on("error", reject);
			});
		for (let i = 0; i < 70; i++)
			await assert.rejects(get(`unknown-${i}.example.test`));
		assert.equal(await get("home.example.test"), 200);
		assert.equal(await get("localhost"), 200);
		const { stdout } = await openssl("x509", [
			"-in",
			join(dir, "ca.pem"),
			"-noout",
			"-text",
		]);
		assert.match(stdout, /X509v3 Name Constraints: critical/);
		assert.match(stdout, /DNS:home.example.test/);
		// Even possession of an accidentally signed outside leaf does not bypass CA constraints.
		await openssl("req", [
			"-new",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-subj",
			"/CN=www.google.com",
			"-keyout",
			join(dir, "outside.key"),
			"-out",
			join(dir, "outside.csr"),
		]);
		await writeFile(
			join(dir, "outside.ext"),
			"subjectAltName=DNS:www.google.com\n",
		);
		await openssl("x509", [
			"-req",
			"-in",
			join(dir, "outside.csr"),
			"-CA",
			join(dir, "ca.pem"),
			"-CAkey",
			join(dir, "ca.key"),
			"-set_serial",
			"123",
			"-days",
			"1",
			"-extfile",
			join(dir, "outside.ext"),
			"-out",
			join(dir, "outside.pem"),
		]);
		await openssl("verify", [
			"-CAfile",
			join(dir, "ca.pem"),
			join(dir, "owner.pem"),
		]);
		await assert.rejects(
			openssl("verify", [
				"-CAfile",
				join(dir, "ca.pem"),
				join(dir, "outside.pem"),
			]),
			(error) =>
				/permitted subtree violation/.test(error.stdout + error.stderr),
		);
	} finally {
		if (server) await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});

test("adding owner-approved names requires explicit CA rotation and survives restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-"));
	try {
		const tls = await quickstartTls(dir);
		const previous = new X509Certificate(await readFile(join(dir, "ca.pem")))
			.fingerprint256;
		await assert.rejects(
			tls.updateNames(["192.168.2.40"]),
			/tls_ca_rotation_required/,
		);
		assert.equal(
			new X509Certificate(await readFile(join(dir, "ca.pem"))).fingerprint256,
			previous,
		);
		const next = await tls.updateNames(["192.168.2.40"], { rotateCA: true });
		assert.equal(
			new X509Certificate(next.cert).checkIP("192.168.2.40"),
			"192.168.2.40",
		);
		assert.notEqual(next.caFingerprint, previous);
		const restarted = await quickstartTls(dir);
		assert.equal(
			new X509Certificate(restarted.cert).checkIP("192.168.2.40"),
			"192.168.2.40",
		);
		await assert.rejects(
			tls.updateNames(["bad\nsubjectAltName=DNS:evil"]),
			/invalid_tls_names/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
