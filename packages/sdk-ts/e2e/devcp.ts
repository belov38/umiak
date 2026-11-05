// Basic flow of @umiak/sdk against an owner homelab stack. Not a unit test:
// it creates a sandbox on Proxmox. Credentials come from the SDK chain (UMIAK_API_KEY,
// UMIAK_ACCESS_TOKEN, or `umiak auth token --json` of the CLI profile on PATH).
//
//   node packages/sdk-ts/e2e/devcp.ts
//
// Prints one "ok <step>" line per step; exits 1 on the first failure and deletes the
// sandbox in any case.

import { Umiak } from "@umiak/sdk";

function check(cond: boolean, what: string): void {
	if (!cond) throw new Error(`check failed: ${what}`);
	console.log(`ok ${what}`);
}

const umiak = new Umiak();
const sb = await umiak.sandboxes.create(
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
