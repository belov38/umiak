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
import { s2SerialPayload } from "../../packages/pve/src/index.ts";
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
	await waitForDesktopBudget();
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

	const result = await io.exec(["bash", "-s"], {
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
		const diagnostics = await io.exec([
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
} finally {
	try {
		if (vmid !== undefined) {
			await machines.delete(vmid);
			console.log(`cleaned VM ${vmid}`);
		}
	} finally {
		ctx.close();
	}
}
