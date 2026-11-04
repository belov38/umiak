// Opt-in image acceptance; requires a built image, no Proxmox access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const image = process.env.UMIAK_CP_TEST_IMAGE;
const docker = (...args) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
test("offline bootstrap preserves identity and hands each consumer its secret copies", {
	skip: !image,
}, () => {
	const volume = `umiak-s20-init-${process.pid}`;
	const args = [
		"run",
		"--rm",
		"--network",
		"none",
		"--user",
		"0:0",
		"-v",
		`${volume}:/secrets`,
		"-e",
		"UMIAK_GATEWAY_SECRETS_DIR=/secrets/gateway",
		"-e",
		"UMIAK_SECRETS_DIR=/secrets/pve",
	];
	try {
		const init = () =>
			docker(
				...args,
				"--entrypoint",
				"sh",
				image,
				"/app/deploy/compose/quickstart/init.sh",
			);
		const inspect = () =>
			docker(
				...args,
				"--entrypoint",
				"sh",
				image,
				"-ec",
				`
   test "$(stat -c %u /secrets/api/data-keys.json)" = 1000
   test "$(stat -c %a /secrets/api/data-keys.json)" = 600
   test "$(stat -c %u /secrets/gateway/ssh_user_ca)" = 65532
   cmp /secrets/worker/worker-gateway-token /secrets/gateway/worker-gateway-token
   cmp /secrets/web/payload-secret /secrets/api/payload-secret
   sha256sum /secrets/gateway/ca.key /secrets/gateway/ca.pem /secrets/gateway/ssh_user_ca /secrets/api/cursor-key /secrets/database/password /secrets/web/payload-secret
  `,
			);
		init();
		const first = inspect();
		init();
		assert.equal(inspect(), first);
	} finally {
		docker("volume", "rm", "-f", volume);
	}
});
test("runtime contains assets and compiled libraries without dev tools or test sources", {
	skip: !image,
}, () => {
	docker(
		"run",
		"--rm",
		"--network",
		"none",
		"--entrypoint",
		"sh",
		image,
		"-ec",
		`
  test -s /app/quickstart-assets/umiak-node-linux-amd64
  test -s /app/quickstart-assets/umiak-agent-windows-amd64.exe
  test -s /app/quickstart-assets/moonlight-web/LICENSE
  test -s /app/infra/templates/windows/template.yaml
  test -s /app/packages/proto/dist/index.js
  test -s /app/packages/agent-client/dist/index.js
  ! command -v pnpm
  ! command -v bun
  ! command -v go
  test ! -e /app/node_modules/typescript
  test ! -e /app/node_modules/vitest
  test -z "$(find /app/deploy/compose/quickstart -name '*.test.mjs' -print)"
 `,
	);
});
