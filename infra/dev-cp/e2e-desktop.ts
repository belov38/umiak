import { execFileSync } from "node:child_process";
// Real acceptance runner. Uses the existing CLI profile; never logs ticket URLs or secrets.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyLiveDesktopMcp } from "../../apps/mcp/test/live-desktop.ts";
import { makeContext } from "../../apps/template-builder/src/context.ts";
import { verifyDesktopMedia } from "../../apps/web/e2e/desktop-media.ts";
import { type Sandbox, Sbx } from "../../packages/sdk-ts/src/index.ts";
import { waitForDesktopBudget } from "./desktop-budget.ts";
import {
	observeDesktop,
	verifyDesktopIdleHold,
	waitDesktopIdleStop,
} from "./desktop-observe.ts";
import { installTestAgent } from "./guest-package.ts";

const client = new Sbx();
const template = process.env.SBX_E2E_TEMPLATE ?? "linux-desktop";
const windows = template.startsWith("windows");
/** One argument for the remote shell of ssh. */
const shq = (a: string) => `'${a.replaceAll("'", "'\\''")}'`;
/** Runs argv as SYSTEM (Windows) or root (Linux) through QGA on the pve host. */
function guestRoot(
	sb: Sandbox,
	argv: string[],
): { exitcode: number; out: string } {
	const id = Number(observeDesktop(sb.data.slug).runtime_id);
	if (!(id >= 500 && id <= 589)) throw new Error(`unexpected VMID ${id}`);
	const raw = execFileSync(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"HostKeyAlias=pve.tail0000.ts.net",
			"root@100.64.10.2",
			"qm",
			"guest",
			"exec",
			String(id),
			"--timeout",
			"30",
			"--",
			...argv.map(shq),
		],
		{ encoding: "utf8", timeout: 60_000 },
	);
	const r = JSON.parse(raw) as { exitcode?: number; "out-data"?: string };
	return { exitcode: r.exitcode ?? -1, out: r["out-data"] ?? "" };
}
const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const pwsh = (script: string, ...args: string[]) => [
	PWSH,
	"-NoLogo",
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	script,
	...args,
];
const created: Sandbox[] = [];
const removed = new Set<string>();
const budget = () =>
	waitForDesktopBudget(
		created
			.filter((s) => !removed.has(s.id))
			.map((s) => Number(observeDesktop(s.data.slug).runtime_id))
			.filter((id) => id >= 500 && id <= 589),
	);
const output = process.env.SBX_E2E_OUTPUT;
if (!output) throw new Error("SBX_E2E_OUTPUT is required");
await mkdir(output, { recursive: true, mode: 0o700 });
const hash = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
function check(value: unknown, label: string) {
	if (!value) throw new Error(`check failed: ${label}`);
	console.log(`ok ${label}`);
}
try {
	await budget();
	const start = performance.now();
	// SBX_E2E_SANDBOX reuses an existing sandbox (diagnostics); it is never deleted here.
	const reuse = process.env.SBX_E2E_SANDBOX;
	const sb = reuse
		? await client.sandboxes.get(reuse)
		: await client.sandboxes.create({
				template,
				size: "4gb",
				labels: { e2e: "desktop" },
				idleTimeoutSeconds: process.env.SBX_DESKTOP_TEST_AGENT_PACKAGE
					? 300
					: 60,
				ttlSeconds: 3600,
			});
	if (!reuse) created.push(sb);
	await sb.waitUntilReady({ timeoutMs: windows ? 600_000 : 300_000 });
	const createMs = Math.round(performance.now() - start);
	if (process.env.SBX_DESKTOP_TEST_AGENT_PACKAGE) {
		process.env.SBX_PVE_URL ??= "https://100.64.10.2:8006";
		process.env.SBX_PVE_TLS_NAME ??= "pve";
		process.env.SBX_NODE_SSH_HOST ??= "100.64.10.2";
		process.env.SBX_TEMPLATE_VMID_RANGE ??= "595-596";
		const ctx = await makeContext();
		try {
			const row = observeDesktop(sb.data.slug);
			await installTestAgent(
				ctx,
				Number(row.runtime_id),
				row.machine_id ?? "",
				process.env.SBX_DESKTOP_TEST_AGENT_PACKAGE,
			);
		} finally {
			ctx.close();
		}
		const until = Date.now() + 60_000;
		for (;;) {
			try {
				if ((await sb.desktop.status()).state === "ready") break;
			} catch {
				/* Reconnecting after service restart. */
			}
			if (Date.now() > until) throw new Error("test agent did not reconnect");
			await new Promise((done) => setTimeout(done, 1000));
		}
		await client.raw.PATCH("/v1/sandboxes/{sandbox}", {
			params: { path: { sandbox: sb.id } },
			body: { idleTimeoutSeconds: 60 },
		});
		console.log(
			"installed experimental signed agent; immutable recipe rebuild still required",
		);
	}

	console.log(`create_ms ${createMs}`);
	const turnHost = process.env.SBX_DESKTOP_TURN_HOST;
	if (!turnHost) throw new Error("dev TURN host missing");
	const egress = await sb.exec(
		windows
			? pwsh(
					`$h='${turnHost}';$p=[int]'${process.env.SBX_DESKTOP_TURN_PORT ?? ""}';$tls=[int]'${process.env.SBX_DESKTOP_TURN_TLS_PORT ?? ""}';$tid=[byte[]]::new(12);[Security.Cryptography.RandomNumberGenerator]::Fill($tid);$m=[byte[]](0,1,0,0,0x21,0x12,0xa4,0x42)+$tid;$u=[Net.Sockets.UdpClient]::new();$u.Client.ReceiveTimeout=3000;[void]$u.Send($m,$m.Length,$h,$p);$ep=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0);$d=$u.Receive([ref]$ep);if(-not [Linq.Enumerable]::SequenceEqual([byte[]]$d[8..19],$tid)){exit 2};foreach($q in @($p,$tls)){$t=[Net.Sockets.TcpClient]::new();try{if($t.ConnectAsync($h,$q).Wait(2000)){exit 3}}catch{};$t.Dispose()}`,
				)
			: [
					"python3",
					"-I",
					"-c",
					"import socket,struct,os,sys; host=sys.argv[1]; port=int(sys.argv[2]); tid=os.urandom(12); s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(struct.pack('!HHI12s',1,0,0x2112a442,tid),(host,port)); data=s.recv(1024); assert data[8:20]==tid; s.close();\nfor p in (port,int(sys.argv[3])):\n t=socket.socket(); t.settimeout(2); assert t.connect_ex((host,p))!=0, 'VM TCP TURN egress allowed'; t.close()",
					turnHost,
					process.env.SBX_DESKTOP_TURN_PORT ?? "",
					process.env.SBX_DESKTOP_TURN_TLS_PORT ?? "",
				],
	);
	if (egress.exitCode !== 0)
		console.log(`egress exit ${egress.exitCode}: ${egress.stderr.slice(-400)}`);
	check(egress.exitCode === 0, "VM TURN egress UDP only; TCP/TLS blocked");

	check(sb.data.endpoints.desktop, "desktop capability");
	const before = await sb.desktop.screenshot({ cursor: "false" });
	check(
		before.screen.width === 1920 && before.screen.height === 1080,
		"1920x1080 screenshot",
	);
	await writeFile(join(output, "before.png"), before.bytes, { mode: 0o600 });
	const proofText = "S10 экран 世界";
	let baseline: typeof before;
	if (windows) {
		// Win+R runs a pwsh line typed with KEYEVENTF_UNICODE in the console session of user.
		baseline = await sb.desktop.screenshot({ cursor: "false" });
		await sb.desktop.act({
			actions: [
				{ type: "click", x: 960, y: 540 },
				{ type: "key", keys: ["meta", "r"] },
				{ type: "wait", ms: 1500 },
				{
					type: "type",
					text: `pwsh -NoProfile -Command "Set-Content -NoNewline -Encoding utf8 $env:USERPROFILE\\s10-input-proof '${proofText}'"`,
					delayMs: 5,
				},
				{ type: "wait", ms: 300 },
			],
		});
	} else {
		await sb.exec([
			"env",
			"XDG_RUNTIME_DIR=/run/user/1000",
			"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
			"systemd-run",
			"--user",
			"--collect",
			"--unit=s10-test-terminal",
			"--setenv=DISPLAY=:0",
			"--setenv=XAUTHORITY=/home/user/.Xauthority",
			"xfce4-terminal",
			"--disable-server",
			"--geometry=100x25+100+100",
		]);
		await sb.desktop.act({ actions: [{ type: "wait", ms: 1000 }] });
		baseline = await sb.desktop.screenshot({ cursor: "false" });
		await sb.desktop.act({
			actions: [
				{ type: "click", x: 600, y: 400 },
				{
					type: "type",
					text: `printf '%s' '${proofText}' > /tmp/s10-input-proof`,
					delayMs: 5,
				},
			],
		});
	}
	const after = await sb.desktop.screenshot({ cursor: "false" });
	await sb.desktop.act({
		actions: [
			{ type: "key", keys: ["enter"] },
			{ type: "wait", ms: windows ? 4000 : 500 },
		],
	});
	await writeFile(join(output, "after.png"), after.bytes, { mode: 0o600 });
	check(hash(baseline.bytes) !== hash(after.bytes), "input changes screenshot");
	const proof = await sb.exec(
		windows
			? pwsh(
					"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Write((Get-Content -Raw -Encoding utf8 (Join-Path $env:USERPROFILE 's10-input-proof')))",
				)
			: ["cat", "/tmp/s10-input-proof"],
	);
	check(
		proof.exitCode === 0 && proof.stdout === proofText,
		"keyboard Unicode reached the shell",
	);
	const text = "S10 clipboard — Привет 世界";
	await sb.desktop.clipboardSet(text);
	check(
		(await sb.desktop.clipboardGet()).text === text,
		"clipboard round-trip",
	);
	await verifyLiveDesktopMcp(
		sb,
		process.env.SBX_DESKTOP_MCP_URL ?? "",
		windows,
	);
	// The first open starts the streamer: like the Desktop tab, a retryable
	// desktop_starting gets a fresh single-use ticket after 2 s.
	const jar = new Map<string, string>();
	let url = "";
	let response: Response | undefined;
	const openStartedAt = Date.now();
	for (;;) {
		const link = await sb.desktop.link();
		jar.clear();
		url = link.url;
		for (let i = 0; i < 5; i++) {
			response = await fetch(url, {
				redirect: "manual",
				headers: { cookie: [...jar.values()].join("; ") },
			});
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(";")[0];
				if (pair) jar.set(pair.split("=")[0] ?? pair, pair);
			}
			const location = response.headers.get("location");
			if (!location) break;
			const next = new URL(location, url);
			check(
				next.origin === new URL(link.url).origin,
				"gateway redirect stays on desktop origin",
			);
			url = next.href;
		}
		if (response?.status !== 503 || Date.now() - openStartedAt > 90_000) break;
		const body = await response.clone().text();
		if (!body.includes("desktop_starting")) break;
		await new Promise((done) => setTimeout(done, 2000));
	}
	console.log(`stream_open_ms ${Date.now() - openStartedAt}`);
	const page = (await response?.text()) ?? "";
	if (response?.status !== 200)
		console.log(`stream page HTTP ${response?.status}: ${page.slice(0, 300)}`);
	check(
		response?.status === 200 && page.includes("<html"),
		"gateway stream page",
	);
	try {
		await verifyDesktopMedia(
			sb,
			output,
			async () => {
				const holdMs = Number(process.env.SBX_DESKTOP_IDLE_HOLD_MS ?? 0);
				if (holdMs > 0)
					await verifyDesktopIdleHold(
						sb,
						holdMs,
						join(output, "idle-observations.ndjson"),
					);
			},
			Number(process.env.SBX_DESKTOP_IDLE_HOLD_MS ?? 0) > 0,
		);
	} catch (error) {
		const diagnostic = await sb.exec(
			windows
				? pwsh(
						"Get-Content -Tail 80 'C:\\Program Files\\Sunshine\\config\\sunshine.log'",
					)
				: [
						"sudo",
						"journalctl",
						"-u",
						"sbx-moonlight-web",
						"--no-pager",
						"-n",
						"60",
					],
		);
		await writeFile(join(output, "moonlight.log"), diagnostic.stdout, {
			mode: 0o600,
		});
		console.log("media diagnostics", output);
		throw error;
	}
	if (Number(process.env.SBX_DESKTOP_IDLE_HOLD_MS ?? 0) > 0) {
		await waitDesktopIdleStop(sb);
		await budget();
		await sb.resume({}, { wait: true });
	} else {
		await sb.desktop.endStreams();
	}

	// Fork a stopped source so this track uses only 4GiB while S9 is running.
	const credentialHash = async (s: Sandbox) => {
		let out: string;
		if (windows) {
			// state\desktop is SYSTEM-only: read it through QGA, never print the values.
			const r = guestRoot(
				s,
				pwsh(
					"$s=Get-Content -Raw 'C:\\ProgramData\\sbx-agent\\state\\desktop\\identity.json'|ConvertFrom-Json;$j=$s.credentials|ConvertTo-Json -Compress;[BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($j))).Replace('-','').ToLower()",
				),
			);
			out = r.exitcode === 0 ? r.out : "";
		} else {
			const result = await s.exec([
				"sudo",
				"python3",
				"-I",
				"-c",
				"import hashlib,json; s=json.load(open('/var/lib/sbx-agent/desktop/identity.json')); print(hashlib.sha256(json.dumps(s['credentials'],sort_keys=True).encode()).hexdigest())",
			]);
			out = result.exitCode === 0 ? result.stdout : "";
		}
		check(
			/^[a-f0-9]{64}\s*$/.test(out),
			"streamer credential digest available",
		);
		return out.trim();
	};
	const original = await credentialHash(sb);
	await sb.stop({ wait: true });
	await budget();
	const copy = await sb.fork();
	created.push(copy);
	await copy.waitUntilReady();
	check(
		original && original !== (await credentialHash(copy)),
		"fork gets fresh streamer state",
	);
	await copy.delete({ wait: true });
	removed.add(copy.id);
	await budget();
	await sb.resume({}, { wait: true });
	check(
		(await sb.desktop.status()).state === "ready",
		"stop/resume desktop ready",
	);
	await sb.desktop.screenshot();
	const revoked = await fetch(url, {
		redirect: "manual",
		headers: { cookie: [...jar.values()].join("; ") },
	});
	check(revoked.status === 401, "old desktop cookie revoked after stop/resume");
	console.log(`artifacts ${output}`);
} catch (error) {
	for (const sandbox of created) {
		try {
			const row = observeDesktop(sandbox.data.slug);
			const id = Number(row.runtime_id);
			if (id >= 500 && id <= 589) {
				const log = guestRoot(
					sandbox,
					windows
						? pwsh(
								"Get-Content -Tail 200 'C:\\ProgramData\\sbx-agent\\logs\\agent.log'",
							)
						: ["journalctl", "-u", "sbx-agent", "--no-pager", "-n", "100"],
				).out;
				await writeFile(join(output, "agent-failure.log"), log, {
					mode: 0o600,
				});
			}
		} catch {
			/* Cleanup still runs if a failed guest cannot be inspected. */
		}
	}
	console.log("failure artifacts", output);
	throw error;
} finally {
	const results = await Promise.allSettled(
		created.reverse().map((sb) => sb.delete({ wait: true })),
	);
	const errors = results.filter((r) => r.status === "rejected");
	if (errors.length) {
		console.error(`desktop cleanup failed for ${errors.length} sandboxes`);
		process.exitCode = 1;
	} else console.log("ok delete cleanup");
}
