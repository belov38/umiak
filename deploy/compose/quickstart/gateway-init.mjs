// Fresh quickstart gateway trust. Never used by the existing dev-stand deployment.

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const directory = process.env.UMIAK_GATEWAY_SECRETS_DIR ?? "/gateway-secrets";
const pveDirectory = process.env.UMIAK_SECRETS_DIR ?? "/pve-secrets";
mkdirSync(directory, { recursive: true, mode: 0o755 });
function run(command, args) {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0)
		throw new Error(`${command} failed (${result.status})`);
}
const ca = join(directory, "ca.pem"),
	key = join(directory, "ca.key");
if (existsSync(ca) !== existsSync(key))
	throw new Error("Gateway CA is incomplete; restore both files from backup");
if (!existsSync(ca)) {
	run("openssl", [
		"genpkey",
		"-algorithm",
		"EC",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-out",
		`${key}.new`,
	]);
	run("openssl", [
		"req",
		"-x509",
		"-new",
		"-key",
		`${key}.new`,
		"-sha256",
		"-days",
		"3650",
		"-subj",
		"/CN=Umiak quickstart guest CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE,pathlen:0",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign",
		"-out",
		`${ca}.new`,
	]);
	renameSync(`${key}.new`, key);
	renameSync(`${ca}.new`, ca);
}
let domain = "umiak.localhost",
	host = "tunnel.localhost";
const network = join(pveDirectory, "quickstart-network.json");
if (existsSync(network)) {
	const config = JSON.parse(readFileSync(network, "utf8"));
	if (config.previewDomain) domain = config.previewDomain;
	if (config.tunnelUrl) host = new URL(config.tunnelUrl).hostname;
}
const dns = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
if (!dns.test(domain) || !dns.test(host))
	throw new Error(
		"Gateway requires DNS names (use sslip.io for an IP address)",
	);
const stamp = JSON.stringify({ domain, host });
const stampPath = join(directory, "quickstart-names.json");
if (existsSync(stampPath) && readFileSync(stampPath, "utf8") !== stamp) {
	// CA, SSH keys and all service tokens survive name changes.
	for (const file of ["umiak.pem", "umiak.key", "tunnel.pem", "tunnel.key"]) {
		const path = join(directory, file);
		if (existsSync(path)) unlinkSync(path);
	}
}
run("/umiak-gateway", [
	"dev-secrets",
	`-dir=${directory}`,
	`-domain=${domain}`,
	`-tunnel-host=${host}`,
	`-ssh-host=${host}`,
	"-owner=65532:65532",
	"-worker-owner=1000:1000",
]);
writeFileSync(stampPath, stamp, { mode: 0o600 });
