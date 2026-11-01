// Live check of S10 13.2 "operator block" on CT 590: a blocked desktop sandbox refuses
// input, clipboard writes, links and access like exec, and the block revokes the desktop
// cookie. The block is applied the way core's blockSandbox does it (row + NOTIFY), because
// the e2e user is not an operator. Never logs ticket URLs or cookies.
//
//   SBX_API_URL=<dev api> NODE_EXTRA_CA_CERTS=<dev ca> mise exec -- node infra/dev-cp/desktop-block-probe.ts
import { execFileSync } from "node:child_process";
import { type Sandbox, Sbx } from "../../packages/sdk-ts/src/index.ts";
import { runningSandboxMemory } from "./desktop-budget.ts";

const ssh = process.env.SBX_DEVCP_SSH ?? "sbx@192.168.68.90";
function sql(text: string): string {
	return execFileSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			ssh,
			"docker",
			"exec",
			"-i",
			"sbx-postgres-1",
			"psql",
			"-v",
			"ON_ERROR_STOP=1",
			"-U",
			"sbx",
			"-d",
			"sbx",
			"-At",
		],
		{ input: text, encoding: "utf8", timeout: 30_000 },
	).trim();
}
function check(value: unknown, label: string) {
	if (!value) throw new Error(`check failed: ${label}`);
	console.log(`ok ${label}`);
}
const code = (p: Promise<unknown>) =>
	p.then(
		() => "ok",
		(e: unknown) =>
			`${(e as { code?: string }).code}:${(e as { details?: { reason?: string } }).details?.reason ?? ""}`,
	);
async function open(url: string) {
	const jar = new Map<string, string>();
	let response: Response | undefined;
	let next = url;
	for (let i = 0; i < 5; i++) {
		response = await fetch(next, {
			redirect: "manual",
			headers: { cookie: [...jar.values()].join("; ") },
		});
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";")[0] ?? "";
			jar.set(pair.split("=")[0] ?? pair, pair);
		}
		const location = response.headers.get("location");
		if (!location) break;
		next = new URL(location, next).href;
	}
	return { status: response?.status, jar, url: next };
}

const client = new Sbx();
let sb: Sandbox | undefined;
try {
	// One 4 GiB sandbox next to whatever runs in 500-599 (a template build included).
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
	sb = await client.sandboxes.create({
		template: process.env.SBX_E2E_TEMPLATE ?? "linux-desktop",
		size: "4gb",
		labels: { e2e: "desktop" },
		ttlSeconds: 1800,
	});
	await sb.waitUntilReady({ timeoutMs: 600_000 });
	const id = sb.data.id;
	const raw = sql(
		`SELECT id FROM runtime.sandboxes WHERE slug='${sb.data.slug}'`,
	);
	check(/^[0-9a-f-]{36}$/.test(raw), "sandbox row");
	// A viewer with a cookie before the block (retry while the streamer starts).
	let viewer = await open((await sb.desktop.link()).url);
	for (let i = 0; viewer.status === 503 && i < 30; i++) {
		await new Promise((done) => setTimeout(done, 2000));
		viewer = await open((await sb.desktop.link()).url);
	}
	check(viewer.status === 200, "viewer opened before the block");
	const epoch = () =>
		sql(
			`SELECT auth_epoch||':'||pending_disconnect FROM runtime.sandbox_desktops WHERE sandbox_id='${raw}'`,
		);
	const before = epoch();
	sql(
		`UPDATE runtime.sandboxes SET blocked=true,block_reason='abuse',blocked_at=now(),version=version+1 WHERE id='${raw}'; SELECT pg_notify('sbx_ssh_revoke',''),pg_notify('sbx_identity','sandboxes:${raw}');`,
	);
	const blocked = "forbidden:sandbox_blocked";
	check(
		(await code(sb.exec(["true"]))) === blocked,
		"exec 403 sandbox_blocked",
	);
	check(
		(await code(
			sb.desktop.act({ actions: [{ type: "type", text: "id\n" }] }),
		)) === blocked,
		"POST /desktop/actions 403 sandbox_blocked",
	);
	check(
		(await code(sb.desktop.clipboardSet("x"))) === blocked,
		"PUT /desktop/clipboard 403 sandbox_blocked",
	);
	check(
		(await code(sb.desktop.link())) === blocked,
		"POST /desktop/links 403 sandbox_blocked",
	);
	check(
		(await code(sb.desktop.setAccess("sso"))) === blocked,
		"PUT /desktop/access 403 sandbox_blocked",
	);
	check(
		(await code(sb.desktop.screenshot({ format: "png" }))) === "ok",
		"screenshot (read) still allowed",
	);
	let after = before;
	for (let i = 0; i < 20 && after === before; i++) {
		await new Promise((done) => setTimeout(done, 500));
		after = epoch();
	}
	const [b, a] = [before, after].map((v) => Number(v.split(":")[0]));
	check(
		(a ?? 0) > (b ?? 0) && after.endsWith(":false"),
		`block advanced the desktop epoch and ended streams (${before} -> ${after})`,
	);
	const old = await fetch(viewer.url, {
		redirect: "manual",
		headers: { cookie: [...viewer.jar.values()].join("; ") },
	});
	check(
		old.status === 401 || old.status === 403,
		`old viewer cookie refused (${old.status})`,
	);
	sql(
		`UPDATE runtime.sandboxes SET blocked=false,block_reason=NULL,blocked_at=NULL,version=version+1 WHERE id='${raw}'`,
	);
	check(
		(await code(
			sb.desktop.act({ actions: [{ type: "move", x: 5, y: 5 }] }),
		)) === "ok",
		"unblocked: actions work again",
	);
	console.log(`sandbox ${id}`);
} finally {
	if (sb) await sb.delete({ wait: true });
	console.log("ok delete cleanup");
}
