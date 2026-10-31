// Basic flow of @sbx/sdk against a real stack (infra/dev-cp/e2e.sh). Not a unit test:
// it creates a sandbox on Proxmox. Credentials come from the SDK chain (SBX_API_KEY,
// SBX_ACCESS_TOKEN, or `sbx auth token --json` of the CLI profile on PATH).
//
//   node packages/sdk-ts/e2e/devcp.ts
//
// Prints one "ok <step>" line per step; exits 1 on the first failure and deletes the
// sandbox in any case.

import { Sbx } from "@sbx/sdk";

function check(cond: boolean, what: string): void {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`ok ${what}`);
}

const sbx = new Sbx();
const sb = await sbx.sandboxes.create(
	{ template: "linux", env: { E2E_SDK: "ts" }, labels: { e2e: "sdk-ts" } },
	{ wait: true },
);
console.log(`sandbox ${sb.slug} ${sb.id}`);
try {
	check(sb.state === "ready", "create wait ready");
	const r = await sb.exec([
		"sh",
		"-c",
		'echo "$E2E_SDK"; echo err >&2; exit 3',
	]);
	check(
		r.stdout === "ts\n" && r.stderr === "err\n" && r.exitCode === 3,
		"exec",
	);
	await sb.files.writeText("sdk-ts.txt", "hello from ts\n");
	check((await sb.files.readText("sdk-ts.txt")) === "hello from ts\n", "files");
	const cmd = await sb.start([
		"sh",
		"-c",
		"for i in 1 2 3; do echo n$i; sleep 1; done",
	]);
	const exit = await cmd.wait();
	check(exit.exitCode === 0, "start and wait");
	const port = await sb.ports.host(3000, { access: "token" });
	check(
		port.url.includes("-3000.") && typeof port.token === "string",
		"port host",
	);
} finally {
	await sb.delete();
	console.log("ok delete");
}
