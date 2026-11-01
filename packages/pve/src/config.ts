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
	/** Sandbox VMIDs (pve: 500-589; CT 590 is dev infrastructure). */
	vmidRange: { min: number; max: number };
	/**
	 * Recipe slots on the dev stand: Linux 597, Linux desktop 596, Windows desktop 595,
	 * Windows 598. Bound each build to its exact slot; 599 is a protected legacy reservation.
	 */
	templateVmidRange: { min: number; max: number };
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

function parseRange(name: string, v: string): { min: number; max: number } {
	const m = /^(\d+)-(\d+)$/.exec(v);
	if (!m) throw new Error(`${name}: expected <min>-<max>, got ${v}`);
	const r = { min: Number(m[1]), max: Number(m[2]) };
	if (r.min < 100 || r.max < r.min) throw new Error(`${name}: invalid ${v}`);
	return r;
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

	const vmidRange = parseRange(
		"UMIAK_VMID_RANGE",
		get("UMIAK_VMID_RANGE", "500-589"),
	);
	const templateVmidRange = parseRange(
		"UMIAK_TEMPLATE_VMID_RANGE",
		get("UMIAK_TEMPLATE_VMID_RANGE", "597-599"),
	);
	if (
		templateVmidRange.min <= vmidRange.max &&
		vmidRange.min <= templateVmidRange.max
	)
		throw new Error(
			"UMIAK_TEMPLATE_VMID_RANGE overlaps UMIAK_VMID_RANGE: templates and sandboxes must not share VMIDs",
		);

	const templateVmid = parseIntStrict(
		get("UMIAK_TEMPLATE_VMID", "599"),
		"UMIAK_TEMPLATE_VMID",
	);
	const clusterId = parseIntStrict(
		get("UMIAK_CLUSTER_ID", "1"),
		"UMIAK_CLUSTER_ID",
	);
	if (clusterId > 255) throw new Error("UMIAK_CLUSTER_ID must fit in one byte");

	return {
		pveUrl: get("UMIAK_PVE_URL", "https://pve:8006"),
		tokenId: get("UMIAK_PVE_TOKEN_ID", "umiak@pve!dev"),
		tokenSecretFile: path(
			"UMIAK_PVE_TOKEN_SECRET_FILE",
			"~/.config/umiak/pve-token",
		),
		caFile: path("UMIAK_PVE_CA_FILE", "~/.config/umiak/pve-root-ca.pem"),
		tlsName: get("UMIAK_PVE_TLS_NAME", "pve"),
		nodeSshHost: get("UMIAK_NODE_SSH_HOST", "pve"),
		nodeSshKeyFile: path(
			"UMIAK_NODE_SSH_KEY_FILE",
			"~/.config/umiak/umiak-node_ed25519",
		),
		nodeSshKnownHosts: path(
			"UMIAK_NODE_SSH_KNOWN_HOSTS",
			"~/.config/umiak/known_hosts",
		),
		vmidRange,
		templateVmidRange,
		clusterId,
		stateDb: path("UMIAK_STATE_DB", "~/.local/state/umiak/poc.db"),
		templateVmid,
		node: get("UMIAK_PVE_NODE", "pve"),
		storage: get("UMIAK_PVE_STORAGE", "local-lvm"),
		vnet: get("UMIAK_PVE_VNET", "umiak0"),
		pool: get("UMIAK_PVE_POOL", "umiak"),
	};
}

/** Reads a secret file that must not be readable by group or others. */
export function readSecretFile(path: string): string {
	if ((statSync(path).mode & 0o077) !== 0) {
		throw new Error(`${path} must have mode 600`);
	}
	return readFileSync(path, "utf8").trim();
}
