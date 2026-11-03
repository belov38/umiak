import { execFile } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { promisify } from "node:util";

const openssl = promisify(execFile);
const validName = (name) =>
	typeof name === "string" &&
	name.length <= 253 &&
	(net.isIP(name) ||
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
			name,
		));
const normalize = (names) =>
	[...new Set(names.map((name) => name.toLowerCase()))].sort();
const constraint = (name) =>
	net.isIP(name) === 4
		? `IP:${name}/255.255.255.255`
		: net.isIP(name) === 6
			? `IP:${name}/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`
			: `DNS:${name}`;

/** Preissue one leaf for the allowlist. TLS handshakes never perform disk I/O or sign. */
export async function quickstartTls(dir, names = []) {
	if (!Array.isArray(names) || names.some((name) => !validName(name)))
		throw new Error("invalid_tls_names");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const policyFile = join(dir, "tls-policy.json");
	const caFile = join(dir, "ca.pem");
	const caKey = join(dir, "ca.key");
	let allowed;
	let credentials;
	let context;
	let caFingerprint;
	const ownNames = normalize([
		"localhost",
		"127.0.0.1",
		"::1",
		...names,
		...Object.values(networkInterfaces())
			.flat()
			.map((value) => value?.address)
			.filter(validName),
	]);
	async function install(next) {
		const staging = join(dir, `rotate-${randomBytes(12).toString("hex")}`);
		await mkdir(staging, { mode: 0o700 });
		try {
			const root = join(staging, "ca.pem");
			const rootKey = join(staging, "ca.key");
			await openssl("openssl", [
				"req",
				"-sha256",
				"-x509",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:P-256",
				"-pkeyopt",
				"ec_param_enc:named_curve",
				"-nodes",
				"-days",
				"365",
				"-subj",
				"/CN=Umiak quickstart owner CA",
				"-keyout",
				rootKey,
				"-out",
				root,
				"-addext",
				"basicConstraints=critical,CA:TRUE,pathlen:0",
				"-addext",
				"keyUsage=critical,keyCertSign,cRLSign",
				"-addext",
				`nameConstraints=critical,${next.map((name) => `permitted;${constraint(name)}`).join(",")}`,
			]);
			const leaf = join(staging, "owner");
			await openssl("openssl", [
				"req",
				"-sha256",
				"-new",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:P-256",
				"-pkeyopt",
				"ec_param_enc:named_curve",
				"-nodes",
				"-subj",
				"/CN=Umiak owner ingress",
				"-keyout",
				`${leaf}.key`,
				"-out",
				`${leaf}.csr`,
			]);
			await writeFile(
				`${leaf}.ext`,
				`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${next.map((name) => `${net.isIP(name) ? "IP" : "DNS"}:${name}`).join(",")}\n`,
				{ mode: 0o600 },
			);
			await openssl("openssl", [
				"x509",
				"-sha256",
				"-req",
				"-in",
				`${leaf}.csr`,
				"-CA",
				root,
				"-CAkey",
				rootKey,
				"-set_serial",
				`0x${randomBytes(16).toString("hex")}`,
				"-days",
				"90",
				"-extfile",
				`${leaf}.ext`,
				"-out",
				`${leaf}.pem`,
			]);
			const nextCredentials = {
				key: await readFile(`${leaf}.key`),
				cert: await readFile(`${leaf}.pem`),
			};
			const nextContext = createSecureContext(nextCredentials);
			const fingerprint = new X509Certificate(await readFile(root))
				.fingerprint256;
			await writeFile(
				join(staging, "tls-policy.json"),
				JSON.stringify({ version: 1, names: next, caFingerprint: fingerprint }),
				{ mode: 0o600 },
			);
			for (const file of [
				"ca.key",
				"ca.pem",
				"owner.key",
				"owner.pem",
				"tls-policy.json",
			])
				await rename(join(staging, file), join(dir, file));
			allowed = new Set(next);
			credentials = nextCredentials;
			context = nextContext;
			caFingerprint = fingerprint;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	if (existsSync(policyFile)) {
		const policy = JSON.parse(await readFile(policyFile, "utf8"));
		if (
			policy.version !== 1 ||
			!Array.isArray(policy.names) ||
			policy.names.some((name) => !validName(name))
		)
			throw new Error("invalid_tls_policy");
		allowed = new Set(policy.names);
		caFingerprint = new X509Certificate(await readFile(caFile)).fingerprint256;
		if (policy.caFingerprint !== caFingerprint)
			throw new Error("invalid_tls_policy");
		if (names.some((name) => !allowed.has(name.toLowerCase())))
			throw new Error("tls_ca_rotation_required");
		credentials = {
			key: await readFile(join(dir, "owner.key")),
			cert: await readFile(join(dir, "owner.pem")),
		};
		const leaf = new X509Certificate(credentials.cert);
		if (!leaf.verify(new X509Certificate(await readFile(caFile)).publicKey))
			throw new Error("invalid_tls_policy");
		if (new Date(leaf.validTo).getTime() - Date.now() < 7 * 86400000) {
			// Reissue only a leaf under the existing constrained CA, without changing trust.
			const stem = join(dir, "renew");
			await openssl("openssl", [
				"req",
				"-new",
				"-key",
				join(dir, "owner.key"),
				"-subj",
				"/CN=Umiak owner ingress",
				"-out",
				`${stem}.csr`,
			]);
			await writeFile(
				`${stem}.ext`,
				`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${[...allowed].map((name) => `${net.isIP(name) ? "IP" : "DNS"}:${name}`).join(",")}\n`,
				{ mode: 0o600 },
			);
			await openssl("openssl", [
				"x509",
				"-sha256",
				"-req",
				"-in",
				`${stem}.csr`,
				"-CA",
				caFile,
				"-CAkey",
				caKey,
				"-set_serial",
				`0x${randomBytes(16).toString("hex")}`,
				"-days",
				"90",
				"-extfile",
				`${stem}.ext`,
				"-out",
				`${stem}.pem`,
			]);
			await rename(`${stem}.pem`, join(dir, "owner.pem"));
			credentials.cert = await readFile(join(dir, "owner.pem"));
		}
		context = createSecureContext(credentials);
	} else {
		// An unrestricted legacy CA must never silently remain trusted.
		if (existsSync(caFile) || existsSync(caKey))
			throw new Error("legacy_tls_ca_requires_rotation");
		await install(ownNames);
	}
	let updating = Promise.resolve();
	return {
		...credentials,
		caFingerprint,
		updateNames(extra, { rotateCA = false } = {}) {
			const update = updating.then(async () => {
				if (
					!Array.isArray(extra) ||
					extra.length > 16 ||
					extra.some((name) => !validName(name))
				)
					throw new Error("invalid_tls_names");
				const next = normalize([...allowed, ...extra]);
				if (next.length !== allowed.size) {
					if (!rotateCA) throw new Error("tls_ca_rotation_required");
					await install(next);
				}
				return { ...credentials, caFingerprint };
			});
			updating = update.catch(() => {});
			return update;
		},
		SNICallback(name, callback) {
			if (!validName(name) || !allowed.has(name.toLowerCase()))
				return callback(new Error("unapproved_sni"));
			callback(null, context);
		},
	};
}
