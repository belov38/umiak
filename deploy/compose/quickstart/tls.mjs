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
// Bun's shipped TLS verifier rejects IP name constraints. DNS remains constrained;
// IP issuance is restricted by this allowlist and the volume-private signing key.
const dnsConstraints = (names) =>
	names
		.filter((name) => !net.isIP(name))
		.map((name) => `permitted;DNS:${name}`)
		.join(",");

/** Preissue one leaf for the allowlist. TLS handshakes never perform disk I/O or sign. */
export async function quickstartTls(
	dir,
	names = [],
	{ leafDays = 90, now = Date.now } = {},
) {
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
	let pendingNames = [];
	let compatibilityRotation = false;
	let updating = Promise.resolve();
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
				`nameConstraints=critical,${dnsConstraints(next)}`,
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
				String(leafDays),
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
				JSON.stringify({ version: 2, names: next, caFingerprint: fingerprint }),
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
	async function renewLeaf() {
		const leaf = new X509Certificate(credentials.cert);
		if (
			new Date(leaf.validTo).getTime() - now() <
			Math.min(7, leafDays / 3) * 86400000
		) {
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
				String(leafDays),
				"-extfile",
				`${stem}.ext`,
				"-out",
				`${stem}.pem`,
			]);
			await rename(`${stem}.pem`, join(dir, "owner.pem"));
			credentials.cert = await readFile(join(dir, "owner.pem"));
			context = createSecureContext(credentials);
			return { ...credentials, caFingerprint };
		}
		return null;
	}
	if (existsSync(policyFile)) {
		const policy = JSON.parse(await readFile(policyFile, "utf8"));
		if (
			![1, 2].includes(policy.version) ||
			!Array.isArray(policy.names) ||
			policy.names.some((name) => !validName(name))
		)
			throw new Error("invalid_tls_policy");
		allowed = new Set(policy.names);
		compatibilityRotation = policy.version === 1;
		caFingerprint = new X509Certificate(await readFile(caFile)).fingerprint256;
		if (policy.caFingerprint !== caFingerprint)
			throw new Error("invalid_tls_policy");
		pendingNames = normalize(names).filter((name) => !allowed.has(name));
		if (compatibilityRotation)
			console.warn(
				"Umiak TLS: existing CA uses IP name constraints unsupported by the shipped CLI. Explicitly rotate at /owner/tls or rotate-ca.mjs, then replace client trust.",
			);
		if (pendingNames.length)
			console.warn(
				`Umiak TLS: CA rotation required for ${pendingNames.join(", ")}; continuing with existing CA and names. Open /owner/tls or use rotate-ca.mjs.`,
			);
		credentials = {
			key: await readFile(join(dir, "owner.key")),
			cert: await readFile(join(dir, "owner.pem")),
		};
		const leaf = new X509Certificate(credentials.cert);
		if (!leaf.verify(new X509Certificate(await readFile(caFile)).publicKey))
			throw new Error("invalid_tls_policy");

		context = createSecureContext(credentials);
	} else {
		// An unrestricted legacy CA must never silently remain trusted.
		if (existsSync(caFile) || existsSync(caKey))
			throw new Error("legacy_tls_ca_requires_rotation");
		await install(ownNames);
	}
	await renewLeaf();
	return {
		...credentials,
		caFingerprint,
		status() {
			const warning = pendingNames.length
				? `CA rotation required for ${pendingNames.join(", ")}. Existing addresses continue to work. Rotate at /owner/tls, then replace old client trust.`
				: compatibilityRotation
					? "Existing CA has IP name constraints unsupported by the shipped CLI. Explicitly rotate the owner CA and replace old client trust."
					: null;
			return {
				names: [...allowed],
				pendingNames: [...pendingNames],
				caFingerprint,
				warning,
			};
		},
		renew() {
			const update = updating.then(renewLeaf);
			updating = update.catch(() => {});
			return update;
		},
		updateNames(extra, { rotateCA = false } = {}) {
			const update = updating.then(async () => {
				if (
					!Array.isArray(extra) ||
					extra.length > 16 ||
					extra.some((name) => !validName(name))
				)
					throw new Error("invalid_tls_names");
				const next = normalize([...allowed, ...pendingNames, ...extra]);
				if (rotateCA || next.length !== allowed.size) {
					if (!rotateCA) throw new Error("tls_ca_rotation_required");
					await install(next);
					pendingNames = [];
					compatibilityRotation = false;
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
