import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";

/** Platform configuration. Everything comes from env and file paths (Kubernetes Secrets in production). */
export interface Config {
	pveUrl: string;
	tokenId: string;
	tokenSecretFile: string;
	caFile: string;
	tlsName: string;
	nodeSshHost: string;
	nodeSshKeyFile: string;
	nodeSshKnownHosts: string;
	vmidRange: { min: number; max: number };
	clusterId: number;
	stateDb: string;
	templateVmid: number;
	node: string;
	storage: string;
	vnet: string;
	pool: string;
}

type Env = Record<string, string | undefined>;

function expandHome(p: string, home: string): string {
	return p === "~" || p.startsWith("~/") ? home + p.slice(1) : p;
}

function parseIntStrict(v: string, name: string): number {
	if (!/^\d+$/.test(v)) throw new Error(`${name}: not a number: ${v}`);
	return Number(v);
}

export function loadConfig(
	env: Env = process.env,
	home: string = homedir(),
): Config {
	const get = (k: string, d: string) => env[k] ?? d;
	const path = (k: string, d: string) => expandHome(get(k, d), home);

	const range = get("SBX_VMID_RANGE", "500-598");
	const m = /^(\d+)-(\d+)$/.exec(range);
	if (!m) throw new Error(`SBX_VMID_RANGE: expected <min>-<max>, got ${range}`);
	const vmidRange = { min: Number(m[1]), max: Number(m[2]) };
	if (vmidRange.min < 100 || vmidRange.max < vmidRange.min)
		throw new Error(`SBX_VMID_RANGE: invalid ${range}`);

	const templateVmid = parseIntStrict(
		get("SBX_TEMPLATE_VMID", "599"),
		"SBX_TEMPLATE_VMID",
	);
	const clusterId = parseIntStrict(
		get("SBX_CLUSTER_ID", "1"),
		"SBX_CLUSTER_ID",
	);
	if (clusterId > 255) throw new Error("SBX_CLUSTER_ID must fit in one byte");

	return {
		pveUrl: get("SBX_PVE_URL", "https://pve.tail0000.ts.net:8006"),
		tokenId: get("SBX_PVE_TOKEN_ID", "sbx@pve!poc"),
		tokenSecretFile: path(
			"SBX_PVE_TOKEN_SECRET_FILE",
			"~/.config/sbx/pve-token",
		),
		caFile: path("SBX_PVE_CA_FILE", "~/.config/sbx/pve-root-ca.pem"),
		tlsName: get("SBX_PVE_TLS_NAME", "pve"),
		nodeSshHost: get("SBX_NODE_SSH_HOST", "pve.tail0000.ts.net"),
		nodeSshKeyFile: path(
			"SBX_NODE_SSH_KEY_FILE",
			"~/.config/sbx/sbx-node_ed25519",
		),
		nodeSshKnownHosts: path(
			"SBX_NODE_SSH_KNOWN_HOSTS",
			"~/.config/sbx/known_hosts",
		),
		vmidRange,
		clusterId,
		stateDb: path("SBX_STATE_DB", "~/.local/state/sbx/poc.db"),
		templateVmid,
		node: get("SBX_PVE_NODE", "pve"),
		storage: get("SBX_PVE_STORAGE", "local-lvm"),
		vnet: get("SBX_PVE_VNET", "sbx0"),
		pool: get("SBX_PVE_POOL", "sandbox"),
	};
}

/** Reads a secret file that must not be readable by group or others. */
export function readSecretFile(path: string): string {
	if ((statSync(path).mode & 0o077) !== 0) {
		throw new Error(`${path} must have mode 600`);
	}
	return readFileSync(path, "utf8").trim();
}
