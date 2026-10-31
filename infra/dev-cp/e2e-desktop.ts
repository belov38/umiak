// Real acceptance runner. Uses the existing CLI profile; never logs ticket URLs or secrets.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Sandbox, Sbx } from "../../packages/sdk-ts/src/index.ts";

const client = new Sbx();
const created: Sandbox[] = [];
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
	const start = performance.now();
	const sb = await client.sandboxes.create({
		template: process.env.SBX_E2E_TEMPLATE ?? "linux-desktop",
		size: "4gb",
		labels: { e2e: "desktop" },
	});
	created.push(sb);
	await sb.waitUntilReady({ timeoutMs: 300_000 });
	console.log(`create_ms ${Math.round(performance.now() - start)}`);
	check(sb.data.endpoints.desktop, "desktop capability");
	const before = await sb.desktop.screenshot({ cursor: "false" });
	check(
		before.screen.width === 1920 && before.screen.height === 1080,
		"1920x1080 screenshot",
	);
	await writeFile(join(output, "before.png"), before.bytes, { mode: 0o600 });
	await sb.start(["xfce4-terminal", "--disable-server"]);
	await sb.desktop.act({
		actions: [
			{ type: "wait", ms: 1000 },
			{ type: "click", x: 600, y: 400 },
			{ type: "type", text: "S10 экран keyboard input", delayMs: 5 },
		],
	});
	const after = await sb.desktop.screenshot({ cursor: "false" });
	await writeFile(join(output, "after.png"), after.bytes, { mode: 0o600 });
	check(hash(before.bytes) !== hash(after.bytes), "input changes screenshot");
	const text = "S10 clipboard — Привет 世界";
	await sb.desktop.clipboardSet(text);
	check(
		(await sb.desktop.clipboardGet()).text === text,
		"clipboard round-trip",
	);
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
	await sb.desktop.endStreams();
	// Copy while both 4GB VMs fit the host's 8GB cap. Compare only hashes, never credentials.
	const credentialHash = async (s: Sandbox) =>
		(
			await s.exec([
				"sudo",
				"python3",
				"-I",
				"-c",
				"import hashlib,json; s=json.load(open('/var/lib/sbx-agent/desktop/identity.json')); print(hashlib.sha256(json.dumps(s['credentials'],sort_keys=True).encode()).hexdigest())",
			])
		).stdout.split(" ")[0];
	const original = await credentialHash(sb);
	const copy = await sb.fork();
	created.push(copy);
	await copy.waitUntilReady();
	check(
		original && original !== (await credentialHash(copy)),
		"fork gets fresh streamer state",
	);
	await copy.delete({ wait: true });
	await sb.stop({ wait: true });
	await sb.resume({}, { wait: true });
	check(
		(await sb.desktop.status()).state === "ready",
		"stop/resume desktop ready",
	);
	await sb.desktop.screenshot();
	console.log(`artifacts ${output}`);
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
