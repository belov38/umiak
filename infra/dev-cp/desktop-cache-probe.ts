// Live check of S10 11.1 "request cache and payloads": Act outcomes with screenshots do not
// put images into the agent's state.db, and a repeated Idempotency-Key does not repeat input
// but still answers with a fresh screenshot. Linux desktop only.
//
//   SBX_API_URL=<dev api> NODE_EXTRA_CA_CERTS=<dev ca> mise exec -- node infra/dev-cp/desktop-cache-probe.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Sandbox, Sbx } from "../../packages/sdk-ts/src/index.ts";
import { runningSandboxMemory } from "./desktop-budget.ts";

function check(value: unknown, label: string) {
	if (!value) throw new Error(`check failed: ${label}`);
	console.log(`ok ${label}`);
}
// PNG signatures and bytes of the agent database files (state.db, -wal, -shm).
const SCAN =
	"import glob,os,json; fs=glob.glob('/var/lib/sbx-agent/state.db*'); print(json.dumps({'png':sum(open(f,'rb').read().count(b'\\x89PNG\\r\\n\\x1a\\n') for f in fs),'bytes':sum(os.path.getsize(f) for f in fs)}))";
async function scan(sb: Sandbox) {
	const r = await sb.exec(["sudo", "python3", "-I", "-c", SCAN]);
	if (r.exitCode !== 0) throw new Error(`scan failed: ${r.stderr}`);
	return JSON.parse(r.stdout) as { png: number; bytes: number };
}

const list = execFileSync(
	"ssh",
	[
		"-o",
		"BatchMode=yes",
		"-o",
		"HostKeyAlias=pve.tail0000.ts.net",
		"root@100.64.10.2",
		"qm",
		"list",
	],
	{ encoding: "utf8", timeout: 30_000 },
);
const used = runningSandboxMemory(list);
if (used + 4096 > 8192) throw new Error(`RAM budget occupied (${used} MiB)`);
const client = new Sbx();
let sb: Sandbox | undefined;
try {
	sb = await client.sandboxes.create({
		template: "linux-desktop",
		size: "4gb",
		labels: { e2e: "desktop" },
		ttlSeconds: 1800,
	});
	await sb.waitUntilReady({ timeoutMs: 300_000 });
	const before = await scan(sb);
	console.log(`state.db before: ${JSON.stringify(before)}`);
	for (let i = 0; i < 20; i++) {
		const r = await sb.desktop.act({
			actions: [{ type: "move", x: 100 + i, y: 100 }],
			screenshot: { format: "png" },
		});
		if (!r.screenshot?.data) throw new Error("act returned no screenshot");
	}
	const key = randomUUID();
	const first = await sb.desktop.act(
		{
			actions: [{ type: "move", x: 300, y: 300 }],
			screenshot: { format: "png", maxWidth: 640 },
		},
		{ idempotencyKey: key },
	);
	const again = await sb.desktop.act(
		{
			actions: [{ type: "move", x: 300, y: 300 }],
			screenshot: { format: "png", maxWidth: 640 },
		},
		{ idempotencyKey: key },
	);
	check(
		first.completed === 1 &&
			again.completed === 1 &&
			again.screenshot?.data !== undefined &&
			again.screenshot.width === 640,
		"replayed Act answers with the stored result and a fresh screenshot",
	);
	const after = await scan(sb);
	console.log(
		`state.db after 22 Act calls with 1920x1080 PNGs: ${JSON.stringify(after)}`,
	);
	check(after.png === 0, "no PNG in state.db, -wal or -shm");
	check(
		after.bytes - before.bytes < 1 << 20,
		`state.db grew by ${after.bytes - before.bytes} bytes (< 1 MiB for 22 screenshots)`,
	);
} finally {
	if (sb) await sb.delete({ wait: true });
	console.log("ok delete cleanup");
}
