import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const stack = parse(
	readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8"),
	{ merge: true },
);
const bootstrap = readFileSync(
	new URL("../../../deploy/compose/quickstart/bootstrap.sh", import.meta.url),
	"utf8",
);
describe("homelab worker/gateway secret boundaries", () => {
	it("delivers only the SSH public CA and worker service token to the worker", () => {
		const env = stack.services.worker.environment;
		expect(env.UMIAK_SSH_USER_CA_KEYS_FILE).toBe(
			"/all-secrets/ssh_user_ca.pub",
		);
		expect(env.UMIAK_GATEWAY_SERVICE_TOKEN_FILE).toBe(
			"/all-secrets/worker-gateway-token",
		);
		expect(bootstrap).toContain(
			'cp "$root/gateway/ssh_user_ca.pub" "$root/worker/ssh_user_ca.pub"',
		);
		expect(bootstrap).toContain(
			'cp "$root/gateway/worker-gateway-token" "$root/worker/worker-gateway-token"',
		);
		const secretMount = stack.services.worker.volumes.find(
			(v: unknown) =>
				typeof v === "object" &&
				v !== null &&
				"target" in v &&
				v.target === "/all-secrets",
		);
		expect(secretMount).toMatchObject({
			source: "secrets",
			read_only: true,
			volume: { subpath: "worker" },
		});
		expect(
			stack.services.worker.volumes.some(
				(v: unknown) =>
					typeof v === "string" && v.startsWith("gateway-secrets:"),
			),
		).toBe(false);
		expect(
			stack.services.gateway.environment.UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE,
		).toBe("/gateway-secrets/ssh_user_ca");
	});
});
