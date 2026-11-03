import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
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
		assert.doesNotMatch(stdout, /IP Address:/);
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

test("configured name expansion keeps the old CA serving until explicit rotation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-"));
	try {
		const initial = await quickstartTls(dir, ["first.example.test"]);
		const restarted = await quickstartTls(dir, [
			"first.example.test",
			"new.example.test",
		]);
		assert.equal(restarted.caFingerprint, initial.caFingerprint);
		assert.deepEqual(restarted.status().pendingNames, ["new.example.test"]);
		const rotated = await restarted.updateNames([], { rotateCA: true });
		assert.notEqual(rotated.caFingerprint, initial.caFingerprint);
		assert.equal(
			new X509Certificate(rotated.cert).checkHost("new.example.test"),
			"new.example.test",
		);
		assert.deepEqual(restarted.status().pendingNames, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a short-lived leaf renews at runtime under the same CA", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-"));
	try {
		let now = Date.now();
		const tls = await quickstartTls(dir, [], { leafDays: 1, now: () => now });
		const previous = new X509Certificate(tls.cert);
		now += 23 * 3600000;
		const renewed = await tls.renew();
		assert.ok(renewed);
		assert.notEqual(
			new X509Certificate(renewed.cert).serialNumber,
			previous.serialNumber,
		);
		assert.equal(renewed.caFingerprint, tls.caFingerprint);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("ingress daily renewal check replaces its TLS context without a restart", async () => {
	const { createQuickstartServer } = await import("./server.mjs");
	const { MemoryOwnerRepository, OwnerStore } = await import("./owner.mjs");
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-"));
	let server;
	try {
		let now = Date.now();
		const tls = await quickstartTls(dir, [], { leafDays: 1, now: () => now });
		const previous = new X509Certificate(tls.cert).serialNumber;
		const store = new OwnerStore(new MemoryOwnerRepository());
		await store.init();
		server = createQuickstartServer({
			store,
			tls,
			env: { UMIAK_LOCAL_DENIED_CIDRS: "10.88.0.0/24" },
			renewIntervalMs: 20,
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		now += 23 * 3600000;
		const ca = await readFile(join(dir, "ca.pem"));
		const serial = () =>
			new Promise((resolve, reject) => {
				https
					.get(
						{
							host: "127.0.0.1",
							port: server.address().port,
							path: "/v1/me",
							ca,
							agent: false,
						},
						(res) => {
							const value = res.socket.getPeerCertificate().serialNumber;
							res.resume();
							resolve(value);
						},
					)
					.on("error", reject);
			});
		let current = previous;
		for (let i = 0; i < 50 && current === previous; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			current = await serial();
		}
		now = Date.now();
		assert.notEqual(current, previous);
		await tls.renew();
	} finally {
		if (server) await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});

test("short-lived CA caps both initial and renewed leaf and warns thirty days ahead", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-expiry-"));
	try {
		let now = Date.now();
		const tls = await quickstartTls(dir, [], {
			caDays: 2,
			leafDays: 90,
			now: () => now,
			warnings: false,
		});
		const ca = new X509Certificate(await readFile(join(dir, "ca.pem")));
		assert.ok(
			new Date(new X509Certificate(tls.cert).validTo) <= new Date(ca.validTo),
		);
		assert.match(tls.status().warning, /Owner CA expires/);
		assert.equal(tls.status().caExpiresAt, ca.validTo);
		now += 86400000;
		assert.equal(await tls.renew(), null); // A leaf already capped at CA expiry needs explicit CA rotation.
		now += 2 * 86400000;
		await assert.rejects(tls.renew(), /owner_ca_expired_rotate_required/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("atomic generation pointer ignores interrupted staging and reloads external CA before renewal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-atomic-"));
	try {
		let now = Date.now();
		const serving = await quickstartTls(dir, [], {
			leafDays: 1,
			now: () => now,
		});
		const before = await readlink(join(dir, "current"));
		await mkdir(join(dir, "rotate-interrupted"));
		await writeFile(join(dir, "rotate-interrupted", "ca.pem"), "half-written");
		const restarted = await quickstartTls(dir, [], {
			warnings: false,
			renewOnStart: false,
		});
		assert.equal(restarted.caFingerprint, serving.caFingerprint);
		const next = await restarted.updateNames(["new.example.test"], {
			rotateCA: true,
		});
		assert.notEqual(await readlink(join(dir, "current")), before);
		now += 23 * 3600000;
		const reloaded = await serving.renew();
		assert.ok(reloaded.reloaded);
		assert.equal(reloaded.caFingerprint, next.caFingerprint);
		const ca = new X509Certificate(await readFile(join(dir, "ca.pem")));
		assert.ok(new X509Certificate(reloaded.cert).verify(ca.publicKey));
		assert.equal(
			new X509Certificate(await readFile(join(dir, "owner.pem"))).serialNumber,
			new X509Certificate(reloaded.cert).serialNumber,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("renewing a short leaf never extends past the existing CA", async () => {
	const dir = await mkdtemp(join(tmpdir(), "umiak-tls-renew-cap-"));
	try {
		let now = Date.now();
		const tls = await quickstartTls(dir, [], {
			caDays: 2,
			leafDays: 1,
			now: () => now,
			warnings: false,
		});
		now += 25 * 3600000;
		const renewed = await tls.renew();
		assert.ok(renewed);
		assert.equal(
			new X509Certificate(renewed.cert).validTo,
			new X509Certificate(await readFile(join(dir, "ca.pem"))).validTo,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
