import { execFile } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import {
	copyFile,
	mkdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
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
	{
		leafDays = 90,
		caDays = 3650,
		now = Date.now,
		warnings = true,
		renewOnStart = true,
	} = {},
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
	let caExpiresAt;
	let expiryWarned = false;
	function warnExpiry() {
		if (
			warnings &&
			!expiryWarned &&
			new Date(caExpiresAt).getTime() - now() <= 30 * 86400000
		) {
			console.warn(
				`Umiak TLS: owner CA expires ${caExpiresAt}; rotate explicitly and replace client trust.`,
			);
			expiryWarned = true;
		}
	}
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
	const files = [
		"ca.key",
		"ca.pem",
		"owner.key",
		"owner.pem",
		"tls-policy.json",
	];
	let generation;
	const pointer = join(dir, "current");
	async function publish(staging) {
		const name = `generation-${randomBytes(12).toString("hex")}`;
		await rename(staging, join(dir, name));
		const temp = join(dir, `current-${randomBytes(8).toString("hex")}`);
		await symlink(name, temp);
		await rename(temp, pointer);
		generation = name;
	}
	async function aliases() {
		for (const file of files) {
			const temp = join(dir, `alias-${randomBytes(8).toString("hex")}`);
			await symlink(`current/${file}`, temp);
			await rename(temp, join(dir, file));
		}
	}
	async function signLeaf(staging, stem, root, rootKey) {
		const ca = new X509Certificate(await readFile(root));
		const end = Math.min(
			now() + leafDays * 86400000,
			new Date(ca.validTo).getTime(),
		);
		if (end <= now()) throw Error("owner_ca_expired_rotate_required");
		const stamp = `${new Date(end).toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
		await writeFile(join(staging, "index"), "", { mode: 0o600 });
		await writeFile(join(staging, "serial"), randomBytes(16).toString("hex"), {
			mode: 0o600,
		});
		const config = join(staging, "sign.cnf");
		await writeFile(
			config,
			`[ca]\ndefault_ca=owner\n[owner]\ndatabase=${join(staging, "index")}\nserial=${join(staging, "serial")}\nnew_certs_dir=${staging}\ncertificate=${root}\nprivate_key=${rootKey}\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n`,
			{ mode: 0o600 },
		);
		await openssl("openssl", [
			"ca",
			"-batch",
			"-notext",
			"-config",
			config,
			"-in",
			`${stem}.csr`,
			"-out",
			`${stem}.pem`,
			"-enddate",
			stamp,
			"-extfile",
			`${stem}.ext`,
		]);
	}
	async function loadCurrent() {
		const policy = JSON.parse(await readFile(policyFile, "utf8"));
		const root = new X509Certificate(await readFile(caFile));
		const next = {
			key: await readFile(join(dir, "owner.key")),
			cert: await readFile(join(dir, "owner.pem")),
		};
		const leaf = new X509Certificate(next.cert);
		if (
			policy.caFingerprint !== root.fingerprint256 ||
			!leaf.verify(root.publicKey) ||
			new Date(leaf.validTo) > new Date(root.validTo)
		)
			throw Error("invalid_tls_policy");
		const secure = createSecureContext(next);
		allowed = new Set(policy.names);
		credentials = next;
		context = secure;
		caFingerprint = root.fingerprint256;
		caExpiresAt = root.validTo;
		expiryWarned = false;
		compatibilityRotation = policy.version === 1;
		pendingNames = normalize(names).filter((name) => !allowed.has(name));
		generation = await readlink(pointer);
	}
	// Migrate intact flat credentials before changing any file; aliases then all resolve
	// through one atomic pointer. Abandoned staging generations are never selected.
	if (!existsSync(pointer) && existsSync(policyFile)) {
		const staging = join(dir, `migrate-${randomBytes(8).toString("hex")}`);
		await mkdir(staging, { mode: 0o700 });
		for (const file of files)
			await copyFile(join(dir, file), join(staging, file));
		await publish(staging);
		await aliases();
	} else if (existsSync(pointer)) {
		await aliases();
	}
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
				String(caDays),
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
			await signLeaf(staging, leaf, root, rootKey);
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
			await publish(staging);
			await aliases();
			allowed = new Set(next);
			credentials = nextCredentials;
			context = nextContext;
			caFingerprint = fingerprint;
			caExpiresAt = new X509Certificate(await readFile(caFile)).validTo;
			expiryWarned = false;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
	async function renewLeaf() {
		if ((await readlink(pointer)) !== generation) {
			await loadCurrent();
			return { ...credentials, caFingerprint, reloaded: true };
		}
		warnExpiry();
		const leaf = new X509Certificate(credentials.cert);
		const caEnd = new Date(caExpiresAt).getTime();
		if (caEnd <= now()) throw Error("owner_ca_expired_rotate_required");
		if (new Date(leaf.validTo).getTime() === caEnd) return null;
		if (
			new Date(leaf.validTo).getTime() > new Date(caExpiresAt).getTime() ||
			new Date(leaf.validTo).getTime() - now() <
				Math.min(7, leafDays / 3) * 86400000
		) {
			// Reissue only a leaf under the existing constrained CA, without changing trust.
			const staging = join(dir, `renew-${randomBytes(8).toString("hex")}`);
			await mkdir(staging, { mode: 0o700 });
			for (const file of files)
				await copyFile(join(dir, file), join(staging, file));
			const stem = join(staging, "owner");
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
			await signLeaf(
				staging,
				stem,
				join(staging, "ca.pem"),
				join(staging, "ca.key"),
			);
			if ((await readlink(pointer)) !== generation) {
				await loadCurrent();
				return { ...credentials, caFingerprint, reloaded: true };
			}
			await publish(staging);
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
		if (warnings && compatibilityRotation)
			console.warn(
				"Umiak TLS: existing CA uses IP name constraints unsupported by the shipped CLI. Explicitly rotate at /owner/tls or rotate-ca.mjs, then replace client trust.",
			);
		if (warnings && pendingNames.length)
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
	generation = await readlink(pointer);
	caExpiresAt = new X509Certificate(await readFile(caFile)).validTo;
	if (renewOnStart) await renewLeaf();
	warnExpiry();
	return {
		...credentials,
		caFingerprint,
		status() {
			const expiryWarning =
				new Date(caExpiresAt).getTime() - now() <= 30 * 86400000
					? `Owner CA expires ${caExpiresAt}. Explicitly rotate the CA and replace client trust before expiry.`
					: null;
			const warning = pendingNames.length
				? `CA rotation required for ${pendingNames.join(", ")}. Existing addresses continue to work. Rotate at /owner/tls, then replace old client trust.`
				: compatibilityRotation
					? "Existing CA has IP name constraints unsupported by the shipped CLI. Explicitly rotate the owner CA and replace old client trust."
					: null;
			return {
				names: [...allowed],
				pendingNames: [...pendingNames],
				caFingerprint,
				caExpiresAt,
				warning: [warning, expiryWarning].filter(Boolean).join(" ") || null,
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
