import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type NodeOps, PveApiError, type PveClient } from "@umiak/pve";
import { RAM_CAP_MB, RamGuard } from "./context.ts";
import {
	assertPinnedKey,
	UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT,
} from "./image.ts";
import { ISO_TOOL } from "./seed.ts";
import { pinnedMachine } from "./windows/stages.ts";

// `umiak-tpl preflight`: read-only checks before a build (spec S5 section 7.1)

export interface Check {
	name: string;
	ok: boolean;
	/** Passed, but with less information than wanted. */
	warn?: boolean;
	detail?: string;
}

const MEDIA_STORAGE = "local";
const MB = 1024 * 1024;

async function check(
	name: string,
	fn: () => Promise<Omit<Check, "name">>,
): Promise<Check> {
	try {
		return { name, ...(await fn()) };
	} catch (err) {
		return {
			name,
			ok: false,
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

function commandExists(cmd: string): boolean {
	return (
		spawnSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { stdio: "ignore" })
			.status === 0
	);
}

export async function preflight(d: {
	api: PveClient;
	node: NodeOps;
	cfg: { node: string; pool: string };
	keyFile: string;
	buildMemoryMb?: number;
	hasCommand?: (cmd: string) => boolean;
	/** An iso-install recipe: its user ISO (file, pinned sha256 or "") and the console right. */
	windows?: { isoFile: string; isoSha256: string };
}): Promise<Check[]> {
	const { api, cfg } = d;
	const buildMb = d.buildMemoryMb ?? 4096;
	const has = d.hasCommand ?? commandExists;
	const storagePath = `/storage/${MEDIA_STORAGE}`;
	const checks = [
		await check(
			`token: Datastore.AllocateTemplate on ${storagePath}`,
			async () => {
				const perms = await api.get<Record<string, Record<string, number>>>(
					"/access/permissions",
					{
						path: storagePath,
					},
				);
				const p = perms[storagePath] ?? {};
				return {
					ok: p["Datastore.AllocateTemplate"] === 1,
					detail: Object.keys(p).join(","),
				};
			},
		),
		await check(
			`storage ${MEDIA_STORAGE} has content import and iso`,
			async () => {
				const st = await api.get<{ content?: string }>(
					`/nodes/${cfg.node}/storage/${MEDIA_STORAGE}/status`,
				);
				const content = (st.content ?? "").split(",");
				return {
					ok: content.includes("import") && content.includes("iso"),
					detail: st.content ?? "",
				};
			},
		),
		await check(`RAM for the ${buildMb} MB build VM`, async () => {
			const running = await new RamGuard({
				api,
				node: cfg.node,
				pool: cfg.pool,
				capMb: RAM_CAP_MB,
			}).runningMb();
			const pool = `pool running ${running} MB + ${buildMb} MB, cap ${RAM_CAP_MB} MB`;
			const poolOk = running + buildMb <= RAM_CAP_MB;
			let st: { memory: { free: number; available?: number } };
			try {
				st = await api.get(`/nodes/${cfg.node}/status`);
			} catch (err) {
				// Node status needs Sys.Audit on the node, which the PoC token does not have.
				if (!(err instanceof PveApiError) || err.status !== 403) throw err;
				return {
					ok: poolOk,
					warn: true,
					detail: `node memory not readable (${err.message}); ${pool}`,
				};
			}
			const freeMb = Math.floor((st.memory.available ?? st.memory.free) / MB);
			return {
				ok: freeMb >= buildMb && poolOk,
				detail: `node free ${freeMb} MB; ${pool}`,
			};
		}),
		await check(`ISO tool ${ISO_TOOL}`, async () => ({ ok: has(ISO_TOOL) })),
		await check("Ubuntu cloud image signing key", async () => {
			await assertPinnedKey(
				readFileSync(d.keyFile, "utf8"),
				UBUNTU_CLOUD_IMAGE_KEY_FINGERPRINT,
			);
			return { ok: true, detail: d.keyFile };
		}),
		await check("umiak-node media.list", async () => {
			const r = await d.node.call<{ iso: unknown[]; import: unknown[] }>(
				"media.list",
			);
			return {
				ok: true,
				detail: `${r.iso.length} ISOs, ${r.import.length} images`,
			};
		}),
	];
	if (d.windows) checks.push(...(await windowsChecks(d, d.windows)));
	return checks;
}

/** iso-install: sendkey needs VM.Console, the machine type is pinned, the user ISO is there. */
async function windowsChecks(
	d: { api: PveClient; node: NodeOps; cfg: { node: string; pool: string } },
	w: { isoFile: string; isoSha256: string },
): Promise<Check[]> {
	const poolPath = `/pool/${d.cfg.pool}`;
	return [
		await check(`token: VM.Console on ${poolPath}`, async () => {
			const perms = await d.api.get<Record<string, Record<string, number>>>(
				"/access/permissions",
				{ path: poolPath },
			);
			const p = perms[poolPath] ?? {};
			return {
				ok: p["VM.Console"] === 1,
				detail:
					Object.keys(p).join(",") || "none (run infra/pve/setup.sh console)",
			};
		}),
		await check("machine types (pc-q35-*+pve*)", async () => ({
			ok: true,
			detail: await pinnedMachine(d.api, d.cfg.node),
		})),
		await check(`user ISO ${MEDIA_STORAGE}:iso/${w.isoFile}`, async () => {
			let r: { size: number; sha256: string };
			try {
				r = await d.node.call("media.sha256", { name: w.isoFile });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					ok: false,
					detail: `${msg}; put it there with umiak-tpl iso upload <file> or the Proxmox web UI`,
				};
			}
			if (w.isoSha256 === "")
				return {
					ok: true,
					warn: true,
					detail: `sha256 ${r.sha256} not pinned yet (build with --accept-iso-sha256)`,
				};
			return {
				ok: r.sha256 === w.isoSha256,
				detail:
					r.sha256 === w.isoSha256
						? `${r.size} bytes, sha256 matches`
						: `sha256 ${r.sha256}, pinned ${w.isoSha256}`,
			};
		}),
	];
}
