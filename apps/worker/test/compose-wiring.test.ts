import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The worker side of deploy/compose/gateway.yaml: what the worker needs from the
// gateway's dev secrets. A missing variable here fails only on a real VM (no SSH
// session ever reaches sshd), so the wiring is pinned by this test.

interface Service {
	environment?: Record<string, string>;
	volumes?: string[];
}

const file = new URL("../../../deploy/compose/gateway.yaml", import.meta.url);
const services = (
	parse(readFileSync(file, "utf8")) as { services: Record<string, Service> }
).services;

/** The container path of `name` in the gateway secrets directory, as the worker mounts it. */
function workerPath(name: string): string {
	const mount = services.worker?.volumes
		?.map((v) => v.split(":"))
		.find(([src]) => src === "./secrets/gateway");
	if (mount?.[1] === undefined)
		throw new Error("worker does not mount ./secrets/gateway");
	return `${mount[1]}/${name}`;
}

/** The file name in the gateway secrets directory of a gateway variable. */
function gatewayFile(key: string): string {
	const v = services.gateway?.environment?.[key];
	if (v === undefined || !v.startsWith("/secrets/"))
		throw new Error(`gateway ${key}: ${v}`);
	return v.slice("/secrets/".length);
}

describe("compose: worker and gateway", () => {
	it("the worker sends the public key of the gateway's SSH user CA to agents", () => {
		// The gateway signs its logins to sshd in the VM with SSH_USER_CA_KEY_FILE;
		// the agent trusts what the worker sends in Claim (ssh_user_ca_keys).
		const ca = gatewayFile("UMIAK_GATEWAY_SSH_USER_CA_KEY_FILE");
		expect(services.worker?.environment?.UMIAK_SSH_USER_CA_KEYS_FILE).toBe(
			workerPath(`${ca}.pub`),
		);
	});

	it("the worker uses the gateway's service token", () => {
		expect(services.worker?.environment?.UMIAK_GATEWAY_SERVICE_TOKEN_FILE).toBe(
			workerPath("worker-gateway-token"),
		);
	});
});
