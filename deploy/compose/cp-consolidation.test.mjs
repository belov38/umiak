import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const stack = JSON.parse(
	execFileSync(
		"docker",
		[
			"compose",
			"--env-file",
			"compose.dev.env",
			"-f",
			"compose.yaml",
			"-f",
			"compose.dev.yaml",
			"config",
			"--format",
			"json",
		],
		{ encoding: "utf8" },
	),
);
const cp = "ghcr.io/belov38/umiak-quickstart:dev";
test("product stack uses one published image and one offline bootstrap", () => {
	assert.deepEqual(
		[...new Set(Object.values(stack.services).map((s) => s.image))].sort(),
		[cp, "postgres:18.6-alpine"].sort(),
	);
	for (const removed of ["web", "web-meta", "web-migrate"])
		assert.equal(stack.services[removed], undefined, removed);
	assert.equal(stack.services["gateway-secrets"], undefined);
	const init = stack.services["secrets-init"];
	assert.equal(init.network_mode, "none");
	assert.equal(init.user, "0:0");
	assert.deepEqual(init.entrypoint, [
		"sh",
		"/app/deploy/compose/quickstart/init.sh",
	]);
	assert.equal(
		stack.services.postgres.depends_on["secrets-init"].condition,
		"service_completed_successfully",
	);
});
test("secretless roles bypass credential wrapper and keep isolated mounts", () => {
	for (const role of ["mcp"]) {
		const s = stack.services[role];
		assert.equal(s.image, cp);
		assert.deepEqual(s.entrypoint, ["node"]);
		assert.equal((s.volumes ?? []).length, 0);
	}
	assert.deepEqual(Object.keys(stack.services.worker.networks), ["control"]);
	assert.equal(stack.services["gateway-renewal"].network_mode, "none");
	assert.equal(stack.services.gateway.user, "0:0");
	assert.ok(
		stack.services.gateway.volumes.find((v) => v.source === "gateway-secrets")
			.read_only,
	);
});
test("shared image build never copies the checkout wholesale", () => {
	const file = readFileSync("deploy/compose/quickstart/Dockerfile", "utf8");
	assert.doesNotMatch(file, /^COPY \. \.$/m);
});
