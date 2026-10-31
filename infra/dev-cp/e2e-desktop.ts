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
	const sb = await client.sandboxes.create({
		template: process.env.SBX_E2E_TEMPLATE ?? "linux-desktop",
		size: "4gb",
		labels: { e2e: "desktop" },
		idleTimeoutSeconds: 60,
		ttlSeconds: 3600,
	});
	created.push(sb);
	await sb.waitUntilReady({ timeoutMs: 300_000 });
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
		console.log(
			"installed experimental signed agent; immutable recipe rebuild still required",
		);
	}

	console.log(`create_ms ${createMs}`);
	check(sb.data.endpoints.desktop, "desktop capability");
	const before = await sb.desktop.screenshot({ cursor: "false" });
	check(
		before.screen.width === 1920 && before.screen.height === 1080,
		"1920x1080 screenshot",
	);
	await writeFile(join(output, "before.png"), before.bytes, { mode: 0o600 });
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
	const baseline = await sb.desktop.screenshot({ cursor: "false" });
	await sb.desktop.act({
		actions: [
			{ type: "click", x: 600, y: 400 },
			{
				type: "type",
				text: "printf '%s' 'S10 экран 世界' > /tmp/s10-input-proof",
				delayMs: 5,
			},
			{ type: "key", keys: ["enter"] },
			{ type: "wait", ms: 500 },
		],
	});
	const after = await sb.desktop.screenshot({ cursor: "false" });
	await writeFile(join(output, "after.png"), after.bytes, { mode: 0o600 });
	check(hash(baseline.bytes) !== hash(after.bytes), "input changes screenshot");
	const proof = await sb.exec(["cat", "/tmp/s10-input-proof"]);
	check(
		proof.exitCode === 0 && proof.stdout === "S10 экран 世界",
		"keyboard Unicode reached terminal",
	);
	const text = "S10 clipboard — Привет 世界";
	await sb.desktop.clipboardSet(text);
	check(
		(await sb.desktop.clipboardGet()).text === text,
		"clipboard round-trip",
	);
	await verifyLiveDesktopMcp(sb, process.env.SBX_DESKTOP_MCP_URL ?? "");
	const link = await sb.desktop.link();
	const jar = new Map<string, string>();
	let url = link.url;
	let response: Response | undefined;
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
	check(
		response?.status === 200 && (await response.text()).includes("<html"),
		"gateway stream page",
	);
	try {
		await verifyDesktopMedia(sb, output, async () => {
			const holdMs = Number(process.env.SBX_DESKTOP_IDLE_HOLD_MS ?? 0);
			if (holdMs > 0)
				await verifyDesktopIdleHold(
					sb,
					holdMs,
					join(output, "idle-observations.ndjson"),
				);
		});
	} catch (error) {
		const diagnostic = await sb.exec([
			"sudo",
			"journalctl",
			"-u",
			"sbx-moonlight-web",
			"--no-pager",
			"-n",
			"60",
		]);
		await writeFile(join(output, "moonlight.log"), diagnostic.stdout, {
			mode: 0o600,
		});
		console.log("media diagnostics", output);
		throw error;
	}
	await sb.desktop.endStreams();
	if (Number(process.env.SBX_DESKTOP_IDLE_HOLD_MS ?? 0) > 0) {
		await waitDesktopIdleStop(sb);
		await budget();
		await sb.resume({}, { wait: true });
	}

	// Fork a stopped source so this track uses only 4GiB while S9 is running.
	const credentialHash = async (s: Sandbox) => {
		const result = await s.exec([
			"sudo",
			"python3",
			"-I",
			"-c",
			"import hashlib,json; s=json.load(open('/var/lib/sbx-agent/desktop/identity.json')); print(hashlib.sha256(json.dumps(s['credentials'],sort_keys=True).encode()).hexdigest())",
		]);
		check(
			result.exitCode === 0 && /^[a-f0-9]{64}\s*$/.test(result.stdout),
			"streamer credential digest available",
		);
		return result.stdout.trim();
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
				const log = execFileSync(
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
						"15",
						"--",
						"journalctl",
						"-u",
						"sbx-agent",
						"--no-pager",
						"-n",
						"100",
					],
					{ encoding: "utf8", timeout: 30_000 },
				);
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
