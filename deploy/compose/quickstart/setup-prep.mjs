// Generates a deployment-bound fresh-host script; tokens never enter git or logs.
import { readFileSync } from "node:fs";
export function renderPreparation(config) {
	if (
		config.tokenId &&
		!/^[a-zA-Z0-9._-]+@pve![a-zA-Z0-9._-]+$/.test(config.tokenId)
	)
		throw new Error("Invalid preparation token ID");
	if (
		!/^https:\/\/[a-zA-Z0-9.:[\]-]+$/.test(config.origin) ||
		!/^[a-f0-9]{64}$/.test(config.token) ||
		!/^ssh-ed25519 [a-zA-Z0-9+/=]+(?: [a-zA-Z0-9_-]+)?$/.test(
			config.publicKey,
		) ||
		!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(config.gateway) ||
		!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(config.node)
	)
		throw new Error("Invalid preparation parameters");
	const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
	const python = readFileSync(
		new URL("./setup-prep.py", import.meta.url),
		"utf8",
	);
	return `#!/usr/bin/env bash\nset -euo pipefail\n# Inspect with --dry-run before executing on a fresh Proxmox host.\npython3 - '${encoded}' "$@" <<'UMIAK_PREPARATION_PYTHON'\n${python}\nUMIAK_PREPARATION_PYTHON\n`;
}
export function renderAdoption(config) {
	if (
		!/^https:\/\/[a-zA-Z0-9.:[\]-]+$/.test(config.origin) ||
		!/^[a-f0-9]{64}$/.test(config.token) ||
		!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(config.node)
	)
		throw new Error("Invalid adoption parameters");
	const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
	return `#!/usr/bin/env bash\nset -euo pipefail\npython3 - '${encoded}' "$@" <<'UMIAK_ADOPTION_PYTHON'\n${readFileSync(new URL("./setup-adopt.py", import.meta.url), "utf8")}\nUMIAK_ADOPTION_PYTHON\n`;
}
