// Dev-only signed update on an owned disposable VM; never mutates a template.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { Ctx } from "../../apps/template-builder/src/context.ts";
import { pveGuestIo } from "../../apps/template-builder/src/runner.ts";

export async function installTestAgent(
	ctx: Ctx,
	vmid: number,
	machineId: string,
	path: string,
) {
	if (vmid < 500 || vmid > 589 || !/^[0-9a-f-]{36}$/.test(machineId))
		throw new Error("invalid owned machine");
	const config = await ctx.api.get<{ smbios1: string }>(
		`/nodes/${ctx.cfg.node}/qemu/${vmid}/config`,
	);
	if (!config.smbios1.split(",").includes(`uuid=${machineId}`))
		throw new Error("refuse foreign machine update");
	const io = pveGuestIo(ctx.api, ctx.cfg.node, vmid);
	const tmp = await io.exec(["mktemp", "-d"]);
	const dir = tmp.stdout.trim();
	if (tmp.exitCode !== 0 || !/^\/tmp\/tmp\.[A-Za-z0-9]+$/.test(dir))
		throw new Error("temporary guest directory unavailable");
	try {
		const bytes = gzipSync(readFileSync(path));
		const chunks = Array.from(
			{ length: Math.ceil(bytes.length / 32768) },
			(_, i) => ({
				file: `${dir}/p${String(i).padStart(5, "0")}`,
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
				"-eu",
				"-c",
				'cat "$1"/p* > "$1"/agent.tar.gz\ngzip -d "$1"/agent.tar.gz\nsbx-agent install-package --no-units "$1"/agent.tar\nsystemctl restart sbx-agent',
				"bash",
				dir,
			],
			{ timeoutMs: 120_000 },
		);
		if (install.exitCode !== 0)
			throw new Error("signed test agent install failed");
	} finally {
		await io.exec([
			"python3",
			"-I",
			"-c",
			"import shutil,sys; shutil.rmtree(sys.argv[1])",
			dir,
		]);
	}
}
