// Read generated credentials at execution time, without exposing them in Compose config.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const env = { ...process.env };
const password = readFileSync(
	env.UMIAK_DATABASE_PASSWORD_FILE ?? "/quickstart-db/password",
	"utf8",
).trim();
if (!/^[0-9a-f]{64}$/.test(password))
	throw new Error("Invalid generated database password");
env.DATABASE_URL = `postgres://umiak:${password}@postgres:5432/umiak`;
if (env.UMIAK_PAYLOAD_SECRET_FILE)
	env.PAYLOAD_SECRET = readFileSync(
		env.UMIAK_PAYLOAD_SECRET_FILE,
		"utf8",
	).trim();
if (env.UMIAK_API_CURSOR_KEY_FILE)
	env.UMIAK_API_CURSOR_KEY = readFileSync(
		env.UMIAK_API_CURSOR_KEY_FILE,
		"utf8",
	).trim();
const pveDir = env.UMIAK_SECRETS_DIR ?? "/pve-secrets";
if (existsSync(`${pveDir}/pve-token-id`))
	env.UMIAK_PVE_TOKEN_ID = readFileSync(
		`${pveDir}/pve-token-id`,
		"utf8",
	).trim();
const networkFile =
	env.UMIAK_QUICKSTART_NETWORK_FILE ?? `${pveDir}/quickstart-network.json`;
if (existsSync(networkFile)) {
	const config = JSON.parse(readFileSync(networkFile, "utf8"));
	env.UMIAK_GUEST_SUBNET = config.guestSubnet || "10.88.0.0/24";
	if (config.tunnelUrl) env.UMIAK_TUNNEL_URL = config.tunnelUrl;
	if (config.previewDomain) {
		env.UMIAK_PREVIEW_DOMAIN = config.previewDomain;
		env.UMIAK_PORT_DOMAIN = config.previewDomain;
		env.UMIAK_GATEWAY_PREVIEW_DOMAIN = config.previewDomain;
	}
	if (config.gatewayAddress) {
		const host = new URL(config.tunnelUrl ?? `https://${config.gatewayAddress}`)
			.hostname;
		env.UMIAK_GATEWAY_TUNNEL_HOST = host;
		env.UMIAK_GATEWAY_SSH_HOST = host;
		// Sandbox SSH uses the tailnet address the installer sets; fall back to
		// the gateway host only when none is configured.
		if (!env.UMIAK_SSH_HOST) env.UMIAK_SSH_HOST = host;
	}
}
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) throw new Error("Missing process command");
const identity = env.UMIAK_RUN_UID
	? {
			uid: Number(env.UMIAK_RUN_UID),
			gid: Number(env.UMIAK_RUN_GID ?? env.UMIAK_RUN_UID),
		}
	: {};
const child = spawn(cmd, args, { env, stdio: "inherit", ...identity });
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => child.kill(signal));
child.on("error", (err) => {
	console.error(err.message);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal ? 1 : 0);
});
