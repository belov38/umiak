// Disposable direct-agent spike. The public API/gateway/real viewer acceptance is a separate E2E.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
	machinesFor,
	makeContext,
	registryDir,
} from "../../apps/template-builder/src/context.ts";
import { FileRegistry } from "../../apps/template-builder/src/registry.ts";
import { pveGuestIo } from "../../apps/template-builder/src/runner.ts";
import {
	type SnapshotRef,
	s2SerialPayload,
} from "../../packages/pve/src/index.ts";
import { waitForDesktopBudget } from "./desktop-budget.ts";

const manifest = new FileRegistry(registryDir()).get(process.argv[2] ?? "");
if (
	manifest?.templateSlug !== "linux-desktop" ||
	![595, 596].includes(manifest.pveVmid ?? 0)
)
	throw new Error("expected desktop template595/596");
process.env.SBX_VMID_RANGE ??= "580-589";
const ctx = await makeContext({ node: manifest.node });
const machines = machinesFor(ctx, manifest.pveVmid as number);
const id = randomUUID();
let vmid: number | undefined;
let forkVmid: number | undefined;
let snapshot: SnapshotRef | undefined;
try {
	const start = Date.now();
	vmid = (
		await machines.create({
			size: { cores: 4, memoryMb: 4096 },
			smbios: {
				uuid: id,
				serial: s2SerialPayload(id, randomBytes(32)),
				family: "sbxt1:wss://tunnel.verify.invalid/v1/connect",
			},
		})
	).vmid;
	if (vmid < 500 || vmid > 589) throw new Error("invalid sandbox allocation");
	await waitForDesktopBudget([
		vmid,
		...(forkVmid === undefined ? [] : [forkVmid]),
	]);
	await machines.start(vmid);
	const ready = await machines.waitReady(vmid, {
		startedAt: start,
		timeoutMs: 300_000,
	});
	console.log(
		`clone_boot_qga_ms ${Date.now() - start} VM ${vmid} IP ${ready.ip}`,
	);
	const io = pveGuestIo(ctx.api, ctx.cfg.node, vmid);
	const replacement = process.env.SBX_SPIKE_AGENT_PACKAGE;
	if (replacement) {
		const bytes = gzipSync(readFileSync(replacement));
		const chunks = Array.from(
			{ length: Math.ceil(bytes.length / 32768) },
			(_, i) => ({
				file: `/tmp/s10-agent-${String(i).padStart(5, "0")}.part`,
				content: bytes.subarray(i * 32768, (i + 1) * 32768).toString("base64"),
				encode: 0,
			}),
		);
		for (let i = 0; i < chunks.length; i += 4)
			await Promise.all(
				chunks
					.slice(i, i + 4)
					.map((chunk) =>
						ctx.api.post(
							`/nodes/${ctx.cfg.node}/qemu/${vmid}/agent/file-write`,
							chunk,
						),
					),
			);
		const install = await io.exec(
			[
				"bash",
				"-e",
				"-c",
				"cat /tmp/s10-agent-*.part > /tmp/s10-agent.tar.gz\ngzip -d /tmp/s10-agent.tar.gz\nsystemctl stop lightdm\nsbx-agent install-package --no-units /tmp/s10-agent.tar\nsystemctl restart sbx-agent",
			],
			{ timeoutMs: 120_000 },
		);
		if (install.exitCode !== 0)
			throw new Error(`agent replacement failed: ${install.stderr}`);
		console.log("installed signed replacement agent");
	}

	const probe = async (guest: ReturnType<typeof pveGuestIo>) => {
		const result = await guest.exec(["bash", "-s"], {
			input: readFileSync(
				new URL("./spike-desktop-guest.sh", import.meta.url),
				"utf8",
			),
			timeoutMs: 300_000,
		});
		for (const line of result.stdout.split("\n")) {
			if (line.startsWith("SCREENSHOT "))
				writeFileSync(
					"/tmp/s10-desktop-spike.png",
					Buffer.from(line.slice(11), "base64"),
					{ mode: 0o600 },
				);
			else console.log(line);
		}
		if (result.exitCode !== 0) {
			console.error(result.stderr);
			const diagnostics = await guest.exec([
				"journalctl",
				"-u",
				"lightdm",
				"-u",
				"sbx-agent",
				"-u",
				"sbx-sunshine",
				"-u",
				"sbx-moonlight-web",
				"--no-pager",
				"-n",
				"100",
			]);
			console.error(diagnostics.stdout);
			throw new Error(`desktop spike exit ${result.exitCode}`);
		}
	};
	const credentialHash = async (guest: ReturnType<typeof pveGuestIo>) => {
		const result = await guest.exec([
			"python3",
			"-I",
			"-c",
			"import hashlib,json; s=json.load(open('/var/lib/sbx-agent/desktop/identity.json')); print(hashlib.sha256(json.dumps(s['credentials'],sort_keys=True).encode()).hexdigest())",
		]);
		if (result.exitCode !== 0 || !/^[a-f0-9]{64}\s*$/.test(result.stdout))
			throw new Error("credential digest unavailable");
		return result.stdout.trim();
	};
	await probe(io);
	const original = await credentialHash(io);
	snapshot = await machines.snapshot(vmid);
	await machines.stop(vmid);
	const forkId = randomUUID();
	forkVmid = (
		await machines.fork(snapshot, {
			size: { cores: 4, memoryMb: 4096 },
			smbios: {
				uuid: forkId,
				serial: s2SerialPayload(forkId, randomBytes(32)),
				family: "sbxt1:wss://tunnel.verify.invalid/v1/connect",
			},
		})
	).vmid;
	await waitForDesktopBudget([
		vmid,
		...(forkVmid === undefined ? [] : [forkVmid]),
	]);
	await machines.start(forkVmid);
	await machines.waitReady(forkVmid, { timeoutMs: 300_000 });
	const forkIo = pveGuestIo(ctx.api, ctx.cfg.node, forkVmid);
	await probe(forkIo);
	if (original === (await credentialHash(forkIo)))
		throw new Error("fork reused streamer credentials");
	console.log("fresh_fork_streamer_credentials PASS");
	await machines.delete(forkVmid);
	forkVmid = undefined;
	await machines.deleteSnapshot(snapshot);
	snapshot = undefined;
	await waitForDesktopBudget([
		vmid,
		...(forkVmid === undefined ? [] : [forkVmid]),
	]);
	await machines.start(vmid);
	await machines.waitReady(vmid, { timeoutMs: 300_000 });
	await probe(io);
	if (original !== (await credentialHash(io)))
		throw new Error("resume unexpectedly changed identity credentials");
	console.log("stop_resume PASS");
} finally {
	try {
		if (forkVmid !== undefined) await machines.delete(forkVmid);
		if (snapshot !== undefined) await machines.deleteSnapshot(snapshot);
		if (vmid !== undefined) {
			await machines.delete(vmid);
			console.log(`cleaned VM ${vmid}`);
		}
	} finally {
		ctx.close();
	}
}
