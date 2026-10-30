import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configureVmFirewall,
	familyForTunnelUrl,
	type PveClient,
	Qga,
	sendKey,
} from "@sbx/pve";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { verifyAgentPackage } from "../agent-package.ts";
import type { Manifest, WindowsFacts } from "../manifest.ts";
import {
	isBuiltinStep,
	loadVersions,
	NETWORK_UP_STEP,
	PINNED_MACHINE,
	PRODUCT_KEY_RE,
	REBOOT_STEP,
	recipeDigest,
	recipeFile,
	stepFile,
	type WindowsRecipe,
	type WindowsVersions,
} from "../recipe.ts";
import { newBuildId } from "../registry.ts";
import { type GuestIo, READ_CHUNK, StepFailedError } from "../runner.ts";
import {
	BUILD_TAG,
	type BuildDeps,
	type BuildOptions,
	checkTemplateDisk,
	DEFAULT_POLL_MS,
	DISK_OPTIONS,
	dropBuildFirewall,
	ensureMedia,
	errorText,
	fileSha256,
	guestManifest,
	isUpid,
	MEDIA_STORAGE,
	type Stage,
	type State,
	sleep,
	stepLog,
	TASK_TIMEOUT_MS,
	upload,
	vmStatus,
	waitIpam,
} from "../stages.ts";
import { isProtectedVmid } from "../vmid-guard.ts";
import {
	BUILD_ISO_LABEL,
	buildIsoFiles,
	OFFLINE_ISO_LABEL,
	offlineIsoFiles,
	renderWindowsAgentToml,
} from "./media.ts";
import { networkUp, rebootWindows, runWindowsStep } from "./runner.ts";

// Stages of an iso-install build (spec S9 sections 6, 7, 10): media, vm, install, steps, seal,
// offline, template. build.ts runs them in order, then verify, and rolls back on failure.

const MIN = 60_000;
const SBX_AGENT_EXE = "C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe";
const SYSPREP_DIR = "C:\\Windows\\System32\\Sysprep";
export const SYSPREP_COMMAND = [
	`${SYSPREP_DIR}\\sysprep.exe`,
	"/generalize",
	"/oobe",
	"/shutdown",
	"/quiet",
	`/unattend:${SYSPREP_DIR}\\sbx-unattend.xml`,
];
const SETUPERR_LOG = `${SYSPREP_DIR}\\Panther\\setuperr.log`;
const SETUPERR_TAIL = 50;
/** Enough for any setuperr.log; the read stops there. */
const SETUPERR_MAX_BYTES = 16 * 1024 * 1024;
const GUEST_MANIFEST_DIR = "C:\\ProgramData\\sbx-template";
const GUEST_MANIFEST = `${GUEST_MANIFEST_DIR}\\build.json`;
const BUILD_DIR = "C:\\sbx-build";
/** build.json is written right before this step; the step keeps it. */
export const CLEANUP_STEP = "90-cleanup";
/** "Press any key to boot from CD": one press per interval. */
const INSTALL_KEYS = 20;
const OFFLINE_KEYS = 30;
const DEFAULT_KEY_INTERVAL_MS = 1000;
const SYSPREP_TIMEOUT_MS = 30 * MIN;
const OFFLINE_TIMEOUT_MS = 10 * MIN;
const SEAL_TIMEOUT_MS = 5 * MIN;
const FACTS_TIMEOUT_MS = 5 * MIN;
const ISO_FILE_RE = /^[A-Za-z0-9._()+-]+\.iso$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MACHINE_RE = /^pc-q35-(\d+)\.(\d+)\+pve(\d+)$/;
/** --fail-step: the step's script in the build ISO is replaced by this one. */
const FAIL_STEP_PS1 = 'Write-Output "sbx-tpl: --fail-step"\r\nexit 1\r\n';

export const buildIsoName = (m: Manifest) => `sbx-build-${m.buildId}.iso`;
export const offlineIsoName = (m: Manifest) => `sbx-offline-${m.buildId}.iso`;
export const virtioIsoName = (version: string) =>
	`sbx-virtio-win-${version}.iso`;

export interface WindowsPrepared {
	recipe: WindowsRecipe;
	/** versions.toml with --iso, --iso-sha256 and --edition applied. */
	versions: WindowsVersions;
	manifest: Manifest;
	agentSha256: string;
	/** From --product-key-file; undefined: the generic key of versions.toml. Never recorded. */
	productKey?: string;
}

type Save = (patch: Partial<Manifest>) => void;

/** Stage 1 checks of an iso-install build; nothing is recorded or created yet. */
export function prepareWindows(
	deps: BuildDeps,
	o: BuildOptions,
	recipe: WindowsRecipe,
): WindowsPrepared {
	for (const [flag, v] of [
		["--sbx-cli", o.sbxCli],
		["--api-url", o.apiUrl],
	] as const)
		if (v !== undefined)
			throw new Error(
				`${flag} is not supported for the windows recipe "${o.slug}"`,
			);
	const pinned = loadVersions(recipe);
	const scriptSteps = recipe.steps.filter((s) => !isBuiltinStep(recipe, s));
	if (o.failStep !== undefined && !scriptSteps.includes(o.failStep))
		throw new Error(
			`--fail-step ${o.failStep}: not a script step of "${o.slug}" (${scriptSteps.join(", ")})`,
		);
	// Every step file must be there before the hour-long build starts.
	for (const s of scriptSteps) stepFile(recipe, s);
	if (o.tunnelUrl !== undefined) familyForTunnelUrl(o.tunnelUrl);
	if (o.sshUserCa !== undefined && !existsSync(o.sshUserCa))
		throw new Error(`--ssh-user-ca: ${o.sshUserCa} not found`);
	for (const disk of ["efidisk0", "tpmstate0"] as const)
		if (recipe.firmwareDisks[disk] === undefined)
			throw new Error(`recipe "${o.slug}": hw.${disk} is required for windows`);

	const isoFile = o.iso ?? pinned.iso.file;
	if (!ISO_FILE_RE.test(isoFile) || isoFile.startsWith("sbx-"))
		throw new Error(
			`--iso ${isoFile}: expected the file name of an ISO in ${MEDIA_STORAGE}:iso (not an sbx-* name)`,
		);
	const isoSha256 = o.isoSha256?.toLowerCase();
	if (isoSha256 !== undefined && !HEX64_RE.test(isoSha256))
		throw new Error("--iso-sha256: expected 64 hex characters");
	if (isoSha256 !== undefined && o.acceptIsoSha256)
		throw new Error("--iso-sha256 and --accept-iso-sha256 exclude each other");
	// The pinned sha256 belongs to the pinned file.
	const expected =
		isoSha256 ?? (isoFile === pinned.iso.file ? pinned.iso.sha256 : "");
	if (expected === "" && !o.acceptIsoSha256)
		throw new Error(
			`the sha256 of ${isoFile} is not pinned in versions.toml: pass --iso-sha256 <hex> or --accept-iso-sha256 (prints and records the value the node computes)`,
		);
	if (o.edition !== undefined && o.edition.trim() === "")
		throw new Error("--edition must not be empty");
	let productKey: string | undefined;
	if (o.productKeyFile !== undefined) {
		if (!existsSync(o.productKeyFile))
			throw new Error(`--product-key-file: ${o.productKeyFile} not found`);
		productKey = readFileSync(o.productKeyFile, "utf8").trim();
		// The content is a secret: never echoed.
		if (!PRODUCT_KEY_RE.test(productKey))
			throw new Error(
				`--product-key-file: ${o.productKeyFile} does not hold one XXXXX-XXXXX-XXXXX-XXXXX-XXXXX product key`,
			);
	}
	const versions: WindowsVersions = {
		...pinned,
		iso: {
			...pinned.iso,
			file: isoFile,
			sha256: expected,
			edition: o.edition ?? pinned.iso.edition,
		},
	};
	const agent = verifyAgentPackage(o.agentPackage, o.updateKeysFile, "windows");

	const now = deps.now();
	const version = deps.registry.claimVersion(o.slug, now);
	const fw = recipe.firmwareDisks;
	const windows: WindowsFacts = {
		edition: versions.iso.edition,
		editionId: null,
		build: null,
		ubr: null,
		displayVersion: null,
		family: recipe.source.family,
		isoFile,
		isoSha256: expected,
		virtioWinVersion: versions.virtioWin.version,
		openssh: { source: versions.openssh.source, version: null },
		appxRemoved: [],
		options: { ...recipe.options },
	};
	const manifest: Manifest = {
		buildId: newBuildId(),
		templateSlug: o.slug,
		version,
		os: "windows",
		status: "building",
		node: o.node,
		storage: o.storage,
		pveVmid: null,
		vmName: `sbx-tpl-${o.slug}-${version.replace(".", "-")}`,
		gitCommit: o.gitCommit,
		recipeDigest: recipeDigest(recipe),
		windows,
		license: {
			status: null,
			channel: versions.iso.channel,
			daysRemaining: null,
			expiresAt: null,
		},
		kernel: null,
		systemd: null,
		packages: {},
		tools: {},
		agentVersion: agent.version,
		defaultTunnelUrl: o.tunnelUrl ?? null,
		hw: { ...recipe.hw, cloudinit: recipe.cloudinit },
		diskLayout: {
			efidisk0: { ...fw.efidisk0 },
			[recipe.disk.slot]: { size: `${recipe.disk.sizeGb}G`, ...DISK_OPTIONS },
			tpmstate0: { ...fw.tpmstate0 },
		},
		bootTimeoutS: recipe.bootTimeoutS,
		buildMemoryMb: recipe.buildVm.memoryMb,
		startedAt: now.toISOString(),
		finishedAt: null,
		durationS: null,
	};
	return {
		recipe,
		versions,
		manifest,
		agentSha256: agent.sha256,
		...(productKey !== undefined ? { productKey } : {}),
	};
}

/** The iso-install stages up to and including the template. */
export async function windowsStages(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	st: State,
	save: Save,
	enter: (stage: Stage) => void,
): Promise<void> {
	enter("media");
	await stageMedia(deps, o, p, st, save);
	enter("vm");
	await stageWindowsVm(deps, o, p, st, save);
	const vmid = st.vmid as number;
	const io = deps.io(vmid);
	enter("install");
	await stageInstall(deps, o, p, io, st);
	enter("steps");
	const factsDone = await stageWindowsSteps(deps, o, p, io, st, save);
	enter("seal");
	if (!factsDone) await recordFacts(deps, o, p, io, st, save);
	await stageSysprep(deps, o, io, st);
	if (p.recipe.offline.length > 0) {
		enter("offline");
		await stageOffline(deps, o, io, st);
	}
	deps.ramGuard.release(vmid);
	st.ramReserved = false;
	enter("template");
	await stageWindowsTemplate(deps, o, p, st, save);
}

// media

/** Password of the build's `user` account: random per build, in memory and the build ISO only. */
function newBuildPassword(): string {
	// Fixed classes first, so any complexity policy is met.
	return `Sb9-${randomBytes(18).toString("base64url")}`;
}

/** Writes `file` and `sha256` of [iso] into the versions.toml that defines it; comments stay. */
export function writeIsoPin(
	recipe: WindowsRecipe,
	file: string,
	sha256: string,
): string {
	const owner = [...recipe.stepDirs]
		.reverse()
		.map((d) => join(d, "versions.toml"))
		.find(
			(f) =>
				existsSync(f) &&
				(parseToml(readFileSync(f, "utf8")) as Record<string, unknown>).iso !==
					undefined,
		);
	if (owner === undefined)
		throw new Error(
			`no versions.toml of "${recipe.slug}" has an [iso] section`,
		);
	const lines = readFileSync(owner, "utf8").split("\n");
	const start = lines.findIndex((l) => l.trim() === "[iso]");
	if (start < 0)
		throw new Error(`${owner}: no plain [iso] header line to update`);
	let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
	if (end < 0) end = lines.length;
	const set = (key: string, value: string) => {
		const line = `${key} = ${JSON.stringify(value)}`;
		const i = lines.findIndex(
			(l, n) => n > start && n < end && new RegExp(`^${key}\\s*=`).test(l),
		);
		if (i >= 0) lines[i] = line;
		else {
			lines.splice(start + 1, 0, line);
			end++;
		}
	};
	set("sha256", sha256);
	set("file", file);
	writeFileSync(owner, lines.join("\n"));
	const back = loadVersions(recipe).iso;
	if (back.file !== file || back.sha256 !== sha256)
		throw new Error(
			`${owner}: [iso] did not take file ${file} sha256 ${sha256}`,
		);
	return owner;
}

async function checkUserIso(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	st: State,
	save: Save,
): Promise<void> {
	const { file, sha256: expected } = p.versions.iso;
	let r: { name: string; size: number; sha256: string };
	try {
		r = await deps.node.call("media.sha256", { name: file });
	} catch (err) {
		const hint = /not.?found/i.test(errorText(err))
			? "; put it there with sbx-tpl iso upload <file> or the Proxmox web UI"
			: "";
		throw new Error(
			`user ISO ${MEDIA_STORAGE}:iso/${file}: ${errorText(err)}${hint}`,
			{ cause: err },
		);
	}
	deps.log(`${MEDIA_STORAGE}:iso/${file}: ${r.size} bytes, sha256 ${r.sha256}`);
	if (r.sha256 !== expected) {
		if (!o.acceptIsoSha256)
			throw new Error(
				`${MEDIA_STORAGE}:iso/${file}: sha256 ${r.sha256} differs from the pinned ${expected}; check the ISO, or pass --accept-iso-sha256 to take the new value`,
			);
		const written = writeIsoPin(p.recipe, file, r.sha256);
		deps.log(`--accept-iso-sha256: wrote sha256 ${r.sha256} to ${written}`);
	}
	save({
		windows: { ...(st.m.windows as WindowsFacts), isoSha256: r.sha256 },
	});
}

async function uploadIso(
	deps: BuildDeps,
	o: BuildOptions,
	st: State,
	files: Map<string, string | Buffer>,
	name: string,
	label: string,
	dir: string,
): Promise<void> {
	const path = join(dir, name);
	deps.makeIso(files, path, label);
	const size = statSync(path).size;
	// Recorded first: a failed upload may still leave a file behind.
	st.isos ??= [];
	st.isos.push(name);
	deps.log(`uploading ${name} (${size} bytes)`);
	try {
		await upload(deps, o.node, "iso", await fileSha256(path), {
			name,
			path,
			size,
		});
	} finally {
		rmSync(path, { force: true });
	}
}

export async function stageMedia(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	st: State,
	save: Save,
): Promise<void> {
	const { recipe, versions } = p;
	await checkUserIso(deps, o, p, st, save);

	if (!deps.fetchVirtioWin)
		throw new Error("this build has no virtio-win downloader");
	const vw = versions.virtioWin;
	const got = await deps.fetchVirtioWin(vw);
	if (got.sha256 !== vw.sha256)
		throw new Error(
			`virtio-win ${vw.version}: sha256 ${got.sha256}, pinned ${vw.sha256}`,
		);
	await ensureMedia(deps, o.node, "iso", virtioIsoName(vw.version), got);

	const dir = mkdtempSync(join(tmpdir(), "sbx-tpl-iso-"));
	try {
		// The ISO must carry the bytes prepare verified, not a later version of the file.
		const agentTar = readFileSync(o.agentPackage);
		if (createHash("sha256").update(agentTar).digest("hex") !== p.agentSha256)
			throw new Error(
				`${o.agentPackage} changed after its signature was verified`,
			);
		const files = buildIsoFiles({
			recipe,
			versions,
			agentTar,
			agentVersion: st.m.agentVersion,
			agentToml: renderWindowsAgentToml(o.tunnelUrl),
			...(o.sshUserCa !== undefined
				? { sshUserCa: readFileSync(o.sshUserCa, "utf8") }
				: {}),
			buildPassword: newBuildPassword(),
			buildId: st.m.buildId,
			...(p.productKey !== undefined ? { productKey: p.productKey } : {}),
		});
		if (o.failStep !== undefined)
			files.set(`build/steps/${o.failStep}.ps1`, FAIL_STEP_PS1);
		await uploadIso(
			deps,
			o,
			st,
			files,
			buildIsoName(st.m),
			BUILD_ISO_LABEL,
			dir,
		);
		if (recipe.offline.length > 0)
			await uploadIso(
				deps,
				o,
				st,
				offlineIsoFiles(recipe.offline, recipe.source.drivers),
				offlineIsoName(st.m),
				OFFLINE_ISO_LABEL,
				dir,
			);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// vm

/** The newest `pc-q35-<x>.<y>+pve<n>` the node offers. */
export async function pinnedMachine(
	api: PveClient,
	node: string,
): Promise<string> {
	const types = await api.get<{ id: string }[]>(
		`/nodes/${node}/capabilities/qemu/machines`,
	);
	const key = (id: string) => (MACHINE_RE.exec(id)?.slice(1) ?? []).map(Number);
	const newest = types
		.map((t) => t.id)
		.filter((id) => MACHINE_RE.test(id))
		.sort((a, b) => {
			const [x, y] = [key(a), key(b)];
			for (let i = 0; i < 3; i++)
				if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
			return 0;
		})[0];
	if (newest === undefined)
		throw new Error(`node ${node} offers no pc-q35-*+pve* machine type`);
	return newest;
}

const volume = (storage: string, gib: number, opts: Record<string, string>) =>
	[
		`${storage}:${gib}`,
		...Object.entries(opts).map(([k, v]) => `${k}=${v}`),
	].join(",");

export async function stageWindowsVm(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	st: State,
	save: Save,
): Promise<void> {
	const { api } = deps;
	const { recipe, versions } = p;
	const machine =
		recipe.hw.machine === PINNED_MACHINE
			? await pinnedMachine(api, o.node)
			: recipe.hw.machine;
	const hw = { ...recipe.hw, ...(machine !== undefined ? { machine } : {}) };
	const { vmid, mac } = await deps.allocator.allocateTemplate();
	if (isProtectedVmid(vmid))
		throw new Error(`allocator returned protected VMID ${vmid}`);
	st.vmid = vmid;
	st.mac = mac;
	save({ pveVmid: vmid, hw: { ...hw, cloudinit: recipe.cloudinit } });
	deps.log(`VM ${vmid} ${st.m.vmName} (${machine})`);
	const cd = (name: string) => `${MEDIA_STORAGE}:iso/${name},media=cdrom`;
	const upid = await api.post<string>(`/nodes/${o.node}/qemu`, {
		vmid,
		name: st.m.vmName,
		pool: o.pool,
		...hw,
		cores: recipe.buildVm.cores,
		memory: recipe.buildVm.memoryMb,
		balloon: 0,
		efidisk0: volume(o.storage, 1, recipe.firmwareDisks.efidisk0 ?? {}),
		tpmstate0: volume(o.storage, 1, recipe.firmwareDisks.tpmstate0 ?? {}),
		[recipe.disk.slot]: volume(o.storage, recipe.disk.sizeGb, DISK_OPTIONS),
		// Down until 00-base has set the policies: Windows Update and Store updates during OOBE
		// break sysprep.
		net0: `virtio=${mac},bridge=${o.vnet},firewall=1,link_down=1`,
		ide2: cd(versions.iso.file),
		sata1: cd(virtioIsoName(versions.virtioWin.version)),
		sata2: cd(buildIsoName(st.m)),
		boot: `order=${recipe.disk.slot};ide2`,
		description: `sbx-tpl build ${st.m.buildId}\ngit ${o.gitCommit}`,
	});
	await api.waitTask(o.node, upid, { timeoutMs: TASK_TIMEOUT_MS });
	// Tags after the create, as in stageVm (pool-scoped token).
	await api.put(`/nodes/${o.node}/qemu/${vmid}/config`, { tags: BUILD_TAG });
	await waitIpam(deps, mac, deps.pollMs ?? DEFAULT_POLL_MS);
	await configureVmFirewall(api, o.node, vmid, mac, { ipfilter: true });
}

// install

async function startVm(
	deps: BuildDeps,
	node: string,
	vmid: number,
): Promise<void> {
	const upid = await deps.api.post<string>(
		`/nodes/${node}/qemu/${vmid}/status/start`,
	);
	await deps.api.waitTask(node, upid);
}

/** Enter at "Press any key to boot from CD or DVD", `count` times one interval apart. */
async function pressKeys(
	deps: BuildDeps,
	node: string,
	vmid: number,
	count: number,
): Promise<void> {
	const interval = deps.keyIntervalMs ?? DEFAULT_KEY_INTERVAL_MS;
	for (let i = 0; i < count; i++) {
		await sendKey(deps.api, node, vmid, "ret");
		if (i < count - 1) await sleep(interval);
	}
}

export async function stageInstall(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	io: GuestIo,
	st: State,
): Promise<void> {
	const vmid = st.vmid as number;
	await deps.ramGuard.reserve(vmid, p.recipe.buildVm.memoryMb);
	st.ramReserved = true;
	await startVm(deps, o.node, vmid);
	await pressKeys(deps, o.node, vmid, INSTALL_KEYS);
	// Windows Setup runs unattended; SetupComplete.cmd installs the guest agent at its end.
	const timeoutS = p.recipe.installTimeoutS;
	const deadline = Date.now() + timeoutS * 1000;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	while (!(await io.ping())) {
		if (Date.now() >= deadline)
			throw new Error(
				`the guest agent did not answer within ${timeoutS} s of Windows Setup: check that the ISO has the edition "${p.versions.iso.edition}" (Setup stops at a wrong /IMAGE/NAME) and look at the console of a --keep-on-failure build`,
			);
		await sleep(pollMs);
	}
	deps.log("Windows is installed, the guest agent answers");
}

// steps

/** powershell.exe with the script as -EncodedCommand: no quoting through QGA and the command line. */
function powershell(script: string): string[] {
	return [
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64"),
	];
}

async function mustRun(
	io: GuestIo,
	what: string,
	cmd: string[],
	timeoutMs?: number,
): Promise<string> {
	const r = await io.exec(cmd, timeoutMs !== undefined ? { timeoutMs } : {});
	if (r.exitCode !== 0)
		throw new Error(
			`${what} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`,
		);
	return r.stdout;
}

const FACT_TOOLS = [
	"pwsh",
	"git",
	"node",
	"npm",
	"python",
	"go",
	"bun",
	"uv",
	"gh",
	"claude",
	"codex",
	"opencode",
	"gemini",
];

/** Facts of the installed image as one `FACTS <json>` line (Windows PowerShell 5.1). */
const FACTS_SCRIPT = `$ErrorActionPreference = 'Stop'
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$cv = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
function First-Line([string]$Name, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  $c = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $c) { return $null }
  try {
    $o = & $c.Source @Arguments 2>&1 | Select-Object -First 1
    if ($null -eq $o) { return '' }
    return "$o".Trim()
  } catch { return $null }
}
$tools = [ordered]@{}
foreach ($t in @(${FACT_TOOLS.map((t) => `'${t}'`).join(", ")})) {
  $arg = if ($t -eq 'go') { 'version' } else { '--version' }
  $tools[$t] = First-Line $t @($arg)
}
$sshd = Get-Command sshd.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$ssh = if ($sshd) { $sshd.FileVersionInfo.ProductVersion } else { $null }
$prov = @(Get-AppxProvisionedPackage -Online | ForEach-Object { $_.DisplayName })
$facts = [ordered]@{
  editionId = $cv.EditionID
  build = $cv.CurrentBuild
  ubr = $cv.UBR
  displayVersion = $cv.DisplayVersion
  openssh = $ssh
  tools = $tools
  provisioned = $prov
}
Write-Output ('FACTS ' + ($facts | ConvertTo-Json -Compress -Depth 4))
`;

const nullableString = z.string().nullable().optional();
const factsSchema = z.object({
	editionId: nullableString,
	build: nullableString,
	ubr: z.number().int().nullable().optional(),
	displayVersion: nullableString,
	openssh: nullableString,
	tools: z.record(z.string(), z.string().nullable()),
	// ConvertTo-Json of PowerShell 5.1 may flatten a one-element array.
	provisioned: z
		.union([z.array(z.string()), z.string()])
		.nullable()
		.optional(),
});

export type GuestFacts = z.infer<typeof factsSchema>;

export async function collectWindowsFacts(io: GuestIo): Promise<GuestFacts> {
	const out = await mustRun(
		io,
		"reading the image facts",
		powershell(FACTS_SCRIPT),
		FACTS_TIMEOUT_MS,
	);
	const line = out
		.split(/\r?\n/)
		.find((l) => l.startsWith("FACTS "))
		?.slice("FACTS ".length);
	if (line === undefined)
		throw new Error(
			`the facts script printed no FACTS line: ${out.slice(0, 200)}`,
		);
	return factsSchema.parse(JSON.parse(line));
}

/** Entries of `files/appx-remove.txt` (a display name or `*` pattern per line), if the recipe has it. */
function appxRemovalList(recipe: WindowsRecipe): string[] {
	let file: string;
	try {
		file = recipeFile(recipe, "files/appx-remove.txt");
	} catch {
		return [];
	}
	return readFileSync(file, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
}

/** Entries of the removal list that match no provisioned package any more. */
export function removedAppx(list: string[], provisioned: string[]): string[] {
	const re = (p: string) =>
		new RegExp(
			`^${p
				.split("*")
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join(".*")}$`,
			"i",
		);
	return list.filter((p) => !provisioned.some((n) => re(p).test(n)));
}

/** Facts into the manifest, then the manifest into C:\ProgramData\sbx-template\build.json. */
async function recordFacts(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	io: GuestIo,
	st: State,
	save: Save,
): Promise<void> {
	const f = await collectWindowsFacts(io);
	const provisioned =
		f.provisioned == null
			? []
			: typeof f.provisioned === "string"
				? [f.provisioned]
				: f.provisioned;
	save({
		tools: f.tools,
		windows: {
			...(st.m.windows as WindowsFacts),
			editionId: f.editionId ?? null,
			build: f.build ?? null,
			ubr: f.ubr ?? null,
			displayVersion: f.displayVersion ?? null,
			openssh: {
				source: p.versions.openssh.source,
				version: f.openssh ?? null,
			},
			appxRemoved: removedAppx(appxRemovalList(p.recipe), provisioned),
		},
	});
	await mustRun(
		io,
		`creating ${GUEST_MANIFEST_DIR}`,
		powershell(
			`New-Item -ItemType Directory -Force -Path '${GUEST_MANIFEST_DIR}' | Out-Null`,
		),
	);
	await new Qga(deps.api, o.node).fileWriteWindows(
		st.vmid as number,
		GUEST_MANIFEST,
		Buffer.from(`${JSON.stringify(guestManifest(st.m), null, 2)}\n`),
	);
}

/** Runs the recipe steps; returns whether build.json was written (before 90-cleanup). */
export async function stageWindowsSteps(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	io: GuestIo,
	st: State,
	save: Save,
): Promise<boolean> {
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	let factsDone = false;
	for (const step of p.recipe.steps) {
		if (step === CLEANUP_STEP && !factsDone) {
			await recordFacts(deps, o, p, io, st, save);
			factsDone = true;
		}
		st.step = step;
		deps.log(`-- ${step}`);
		if (step === REBOOT_STEP) {
			await rebootWindows(io, { pollMs });
			continue;
		}
		if (step === NETWORK_UP_STEP) {
			await networkUp(deps.api, o.node, st.vmid as number, st.mac as string, {
				pollMs,
			});
			continue;
		}
		await runWindowsStep(io, {
			step,
			pollMs,
			onLog: stepLog(deps, o, st.m.buildId, step),
			...(deps.signal !== undefined ? { signal: deps.signal } : {}),
		});
	}
	delete st.step;
	return factsDone;
}

// seal

function decodeLog(buf: Buffer): string {
	if (buf[0] === 0xff && buf[1] === 0xfe)
		return buf.subarray(2).toString("utf16le");
	return buf.toString("utf8");
}

/** The last lines of setuperr.log. */
async function setupErrTail(io: GuestIo): Promise<string[]> {
	const chunks: Buffer[] = [];
	let offset = 0;
	while (offset < SETUPERR_MAX_BYTES) {
		const b = await io.readFile(SETUPERR_LOG, offset, READ_CHUNK);
		if (b.length === 0) break;
		chunks.push(b);
		offset += b.length;
	}
	const lines = decodeLog(Buffer.concat(chunks)).split(/\r?\n/);
	while (lines.at(-1) === "") lines.pop();
	return lines.slice(-SETUPERR_TAIL);
}

/**
 * C:\sbx-build goes (90-cleanup's log was read already), `sbx-agent seal`, then sysprep starts
 * through QGA without waiting for it; sysprep powers the VM off. A failed sysprep leaves the VM
 * running, so setuperr.log is read through QGA.
 */
export async function stageSysprep(
	deps: BuildDeps,
	o: BuildOptions,
	io: GuestIo,
	st: State,
): Promise<void> {
	const vmid = st.vmid as number;
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	await mustRun(
		io,
		`removing ${BUILD_DIR}`,
		powershell(
			`if (Test-Path -LiteralPath '${BUILD_DIR}') { Remove-Item -LiteralPath '${BUILD_DIR}' -Recurse -Force }`,
		),
	);
	await mustRun(io, "sbx-agent seal", [SBX_AGENT_EXE, "seal"], SEAL_TIMEOUT_MS);
	const { pid } = await deps.api.post<{ pid: number }>(`${vmPath}/agent/exec`, {
		command: SYSPREP_COMMAND,
	});
	deps.log(`sysprep started (guest PID ${pid})`);

	const fail = async (code: number, reason: string): Promise<never> => {
		let tail: string[] = [];
		try {
			tail = await setupErrTail(io);
		} catch (err) {
			deps.signal?.throwIfAborted();
			deps.log(`reading ${SETUPERR_LOG}: ${errorText(err)}`);
		}
		throw new StepFailedError("sysprep", code, tail, reason);
	};
	const timeoutMs = deps.sysprepTimeoutMs ?? SYSPREP_TIMEOUT_MS;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	let exited = false;
	while ((await vmStatus(deps, o.node, vmid)) !== "stopped") {
		if (!exited) {
			let s: { exited?: number; exitcode?: number } | undefined;
			try {
				s = await deps.api.get(`${vmPath}/agent/exec-status`, { pid });
			} catch {
				// The agent goes away while Windows shuts down.
				deps.signal?.throwIfAborted();
			}
			if (s?.exited) {
				exited = true;
				if ((s.exitcode ?? 0) !== 0)
					await fail(s.exitcode ?? -1, `sysprep exited with ${s.exitcode}`);
			}
		}
		if (Date.now() >= deadline)
			await fail(-1, `sysprep did not power off the VM within ${timeoutMs} ms`);
		await sleep(pollMs);
	}
	deps.log("sysprep powered the VM off");
}

// offline

/**
 * Boots WinPE from the user's ISO with the offline ISO on sata2; offline.cmd edits the sealed
 * system's registry and powers off. A guest agent that answers means the sealed disk booted.
 */
export async function stageOffline(
	deps: BuildDeps,
	o: BuildOptions,
	io: GuestIo,
	st: State,
): Promise<void> {
	const vmid = st.vmid as number;
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	await deps.api.put(`${vmPath}/config`, {
		sata2: `${MEDIA_STORAGE}:iso/${offlineIsoName(st.m)},media=cdrom`,
		boot: "order=ide2",
	});
	await startVm(deps, o.node, vmid);
	await pressKeys(deps, o.node, vmid, OFFLINE_KEYS);
	const timeoutMs = deps.offlineTimeoutMs ?? OFFLINE_TIMEOUT_MS;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	while ((await vmStatus(deps, o.node, vmid)) !== "stopped") {
		if (await io.ping())
			throw new Error(
				"sealed disk booted: the guest agent answered during the offline WinPE stage (OVMF booted the disk instead of the CD); this build's disk is spoiled",
			);
		if (Date.now() >= deadline)
			throw new Error(
				`the offline WinPE boot did not power off within ${timeoutMs} ms (WinPE has no guest agent: look at the console of a --keep-on-failure build)`,
			);
		await sleep(pollMs);
	}
	deps.log("offline stage done");
}

// template

export async function stageWindowsTemplate(
	deps: BuildDeps,
	o: BuildOptions,
	p: WindowsPrepared,
	st: State,
	save: Save,
): Promise<void> {
	const { api } = deps;
	const vmid = st.vmid as number;
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	await dropBuildFirewall(api, vmPath);
	const before = await api.get<Record<string, string>>(`${vmPath}/config`);
	const net0 = (before.net0 ?? "")
		.split(",")
		.filter((f) => f !== "" && !f.startsWith("link_down="))
		.join(",");
	await api.put(`${vmPath}/config`, {
		delete: "ide2,sata1,sata2",
		boot: `order=${p.recipe.disk.slot}`,
		net0,
	});
	const r = await api.post(`${vmPath}/template`);
	if (isUpid(r)) await api.waitTask(o.node, r, { timeoutMs: TASK_TIMEOUT_MS });
	if (st.isos !== undefined && st.isos.length > 0) {
		await deps.node.call("media.remove", { names: st.isos });
		st.isos = [];
	}
	// Proxmox numbers the disks itself: k of base-<vmid>-disk-<k> is read back.
	const cfg = await api.get<Record<string, string>>(`${vmPath}/config`);
	const layout = { ...st.m.diskLayout };
	const lvs: Record<string, string> = {};
	for (const slot of Object.keys(layout)) {
		const volid = (cfg[slot] ?? "").split(",")[0] ?? "";
		const m = /^[^:]+:(base-(\d+)-disk-(\d+))$/.exec(volid);
		if (
			!m?.[1] ||
			!m[3] ||
			volid.split(":")[0] !== o.storage ||
			Number(m[2]) !== vmid
		)
			throw new Error(
				`template ${slot} is "${cfg[slot] ?? ""}", want ${o.storage}:base-${vmid}-disk-<k>`,
			);
		lvs[slot] = m[1];
		layout[slot] = { index: m[3], ...layout[slot] };
	}
	save({ diskLayout: layout });
	await checkTemplateDisk(deps, lvs[p.recipe.disk.slot] as string, st);
	if (st.m.diskUsedGiB !== undefined) save({ diskUsedGiB: st.m.diskUsedGiB });
	await deps.allocator.markActive(vmid);
}
