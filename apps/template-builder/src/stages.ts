import { createHash } from "node:crypto";
import {
	appendFileSync,
	createReadStream,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Allocator,
	configureVmFirewall,
	type NodeOps,
	type OfflineLayerReceipt,
	type PveClient,
	type UploadFile,
} from "@umiak/pve";
import { pveImageName } from "./image.ts";
import {
	layerNodeRequest,
	type VerifiedOfflineLayer,
} from "./layer-release.ts";
import type { Manifest, VerifyResult } from "./manifest.ts";
import { renderOfflineSeed } from "./offline-seed.ts";
import {
	REBOOT_STEP,
	type Recipe,
	type Versions,
	type WindowsVersions,
} from "./recipe.ts";
import type { FileRegistry } from "./registry.ts";
import { type GuestIo, mountSeed, rebootGuest, runStep } from "./runner.ts";
import { writeGuestFile } from "./seal.ts";
import { renderSeed, SEED_AGENT_PACKAGE, type SeedInput } from "./seed.ts";
import { isProtectedVmid } from "./vmid-guard.ts";

// Stages of `umiak-tpl build` (spec S5 section 7.2); build.ts runs them in order and rolls back.

/** Storage of the base images and seed ISOs. */
export const MEDIA_STORAGE = process.env.UMIAK_PVE_MEDIA_STORAGE || "local";
if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(MEDIA_STORAGE))
	throw new Error("Invalid template media storage name");
export const BUILD_TAG = "umiak-tpl";
/** smbios1 of the build VM: serial "ds=nocloud" (base64). Removed with the seed ISO. */
export const BUILD_SMBIOS1 = `serial=${Buffer.from("ds=nocloud").toString("base64")},base64=1`;
export const DISK_OPTIONS = { discard: "on", iothread: "1", ssd: "1" };
const STEP_DIR = "/mnt/seed/build/steps";
/** `--fail-step` runs this script instead of the step (the seed stays unchanged). */
export const FAIL_STEP_SCRIPT = "/run/umiak-tpl-fail-step.sh";
const FAIL_STEP_BODY = 'echo "umiak-tpl: --fail-step"\nexit 1\n';

const MIN = 60_000;
export const TASK_TIMEOUT_MS = 30 * MIN;
const PING_TIMEOUT_MS = 10 * MIN;
const SHUTDOWN_TIMEOUT_MS = 5 * MIN;
const IPAM_TIMEOUT_MS = 15_000;
export const DEFAULT_POLL_MS = 2000;

/** PveApi with the multipart upload. */
export type BuildApi = PveClient & {
	upload<T = unknown>(
		path: string,
		fields: Record<string, string>,
		file: UploadFile,
	): Promise<T>;
};

/** Optional tunnel connect check of verify (dev stand). */
export interface ConnectOptions {
	url: string;
	ctSsh: string;
}

export interface BuildDeps {
	api: BuildApi;
	node: NodeOps;
	allocator: Pick<Allocator, "allocateTemplate" | "markActive" | "release">;
	registry: FileRegistry;
	/** Downloads and verifies the base image (fetchBaseImage with the pinned key). */
	fetchImage: (
		base: Versions["base"],
	) => Promise<{ path: string; sha256: string }>;
	/** iso-install: downloads virtio-win and checks its sha256 (fetchVirtioWin). */
	fetchVirtioWin?: (
		v: WindowsVersions["virtioWin"],
	) => Promise<{ path: string; sha256: string }>;
	io: (vmid: number) => GuestIo;
	/** Writes an ISO 9660 image; `label` is the volume label (default the seed's). */
	makeIso: (
		files: Map<string, string | Buffer>,
		out: string,
		label?: string,
	) => void;
	verify: (
		m: Manifest,
		o: { connect?: ConnectOptions; signal?: AbortSignal },
	) => Promise<VerifyResult>;
	ramGuard: {
		reserve(vmid: number, memoryMb: number): Promise<void>;
		release(vmid: number): void;
	};
	/** Builder messages, one per call. */
	log: (msg: string) => void;
	/** Step output as it arrives. */
	stepOutput?: (step: string, chunk: string) => void;
	now: () => Date;
	/** Called once the build is recorded as `building`. */
	onStart?: (m: Manifest) => void;
	/**
	 * Aborting fails the build at the next Proxmox or guest call and rolls it back. The guest
	 * io of `io` should use an api wrapped with `guardApi`, so long execs stop polling too.
	 */
	signal?: AbortSignal;
	/** Poll interval for the guest and Proxmox (default 2 s). */
	pollMs?: number;
	/** iso-install: interval of the boot-from-CD key presses (default 250 ms); their number is fixed. */
	keyIntervalMs?: number;
	/** iso-install: how long sysprep may take to power the VM off (default 30 min). */
	sysprepTimeoutMs?: number;
	/** iso-install: how long the offline WinPE boot may take (default 10 min). */
	offlineTimeoutMs?: number;
}

export interface BuildOptions {
	offlineLayer?: VerifiedOfflineLayer;
	tunnelCAPin?: string;
	/** Internal production job scope; never a public placement option. */
	nodeBuildJobId?: string;
	/** Explicit fresh build slot, still checked against allocator range and occupied VMs. */
	templateVmid?: number;
	slug: string;
	node: string;
	storage: string;
	pool: string;
	vnet: string;
	agentPackage: string;
	umiakCli?: string;
	apiUrl?: string;
	tunnelUrl?: string;
	sshUserCa?: string;
	keepOnFailure: boolean;
	noVerify: boolean;
	templatesDir: string;
	updateKeysFile: string;
	gitCommit: string;
	/** Step logs go to `<logDir>/<buildId>/<step>.log`. */
	logDir?: string;
	/** Test flag: this step exits 1. */
	failStep?: string;
	connect?: ConnectOptions;
	/** iso-install: the user's ISO in local:iso instead of versions.toml [iso] file. */
	iso?: string;
	/** iso-install: expected sha256 of the user's ISO instead of [iso] sha256. */
	isoSha256?: string;
	/** Verified VirtIO ISO already on PVE storage. */
	virtioIso?: string;
	virtioSha256?: string;
	/** iso-install: take the sha256 the node computes and write it into versions.toml. */
	acceptIsoSha256?: boolean;
	/** iso-install: `/IMAGE/NAME` instead of [iso] edition. */
	edition?: string;
	/** iso-install: file with a product key that replaces the generic one; never recorded. */
	productKeyFile?: string;
}

export type Stage =
	| "prepare"
	| "image"
	| "seed"
	| "media"
	| "vm"
	| "boot"
	| "install"
	| "steps"
	| "offline"
	| "verify-offline"
	| "platform-tools"
	| "vendor-tools"
	| "seal"
	| "template"
	| "verify"
	| "ready";

/** Records a manifest patch in the registry; `unset` drops optional keys. */
export type Save = (
	patch: Partial<Manifest>,
	unset?: (keyof Manifest)[],
) => void;

/** What the build created so far: the rollback removes exactly this. */
export interface State {
	layerMedia?: OfflineLayerReceipt;
	m: Manifest;
	stage: Stage;
	step?: string;
	vmid?: number;
	mac?: string;
	seedUploaded: boolean;
	ramReserved: boolean;
	/** iso-install: build and offline ISOs in local:iso (possibly partly uploaded). */
	isos?: string[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);
export const isUpid = (v: unknown): v is string =>
	typeof v === "string" && v.startsWith("UPID:");

export async function fileSha256(path: string): Promise<string> {
	const h = createHash("sha256");
	for await (const chunk of createReadStream(path)) h.update(chunk);
	return h.digest("hex");
}

/** The copy inside the image and in the seed: everything but `verify`. */
export function guestManifest(m: Manifest): Omit<Manifest, "verify"> {
	const { verify: _verify, ...rest } = m;
	return rest;
}

export interface Prepared {
	recipe: Recipe;
	versions: Versions;
	verifyScript: string;
	manifest: Manifest;
	/** sha256 of the agent package as verified in prepare. */
	agentSha256: string;
}

export async function upload(
	deps: BuildDeps,
	node: string,
	content: "iso" | "import",
	sha256: string,
	file: UploadFile,
): Promise<void> {
	const upid = await deps.api.upload<string>(
		`/nodes/${node}/storage/${MEDIA_STORAGE}/upload`,
		// The order pveproxy accepts; PveApi.upload enforces it as well.
		{ content, "checksum-algorithm": "sha256", checksum: sha256 },
		file,
	);
	await deps.api.waitTask(node, upid, { timeoutMs: TASK_TIMEOUT_MS });
}

/**
 * `name` in local:<content>, uploaded only when it is not there with the same size; a file of
 * another size (a partial earlier upload) is replaced.
 */
export async function ensureMedia(
	deps: BuildDeps,
	node: string,
	content: "iso" | "import",
	name: string,
	file: { path: string; sha256: string },
): Promise<void> {
	const size = statSync(file.path).size;
	const volid = `${MEDIA_STORAGE}:${content}/${name}`;
	const have = (
		await deps.api.get<{ volid: string; size?: number }[]>(
			`/nodes/${node}/storage/${MEDIA_STORAGE}/content`,
			{ content },
		)
	).find((f) => f.volid === volid);
	if (have?.size === size) {
		deps.log(`${volid} is present`);
		return;
	}
	if (have) {
		// An upload never overwrites.
		deps.log(`${volid} has ${have.size} bytes, want ${size}: replacing`);
		await deps.node.call("media.remove", { names: [name] });
	}
	deps.log(`uploading ${name} (${size} bytes)`);
	await upload(deps, node, content, file.sha256, {
		name,
		path: file.path,
		size,
	});
}

/** Base image in local:import, uploaded only when it is not there with the same size. */
export async function stageImage(
	deps: BuildDeps,
	o: BuildOptions,
	versions: Versions,
): Promise<string> {
	const img = await deps.fetchImage(versions.base);
	if (o.offlineLayer && img.sha256 !== versions.base.sha256)
		throw Error("Official base differs from signed layer pin");
	const name = pveImageName(versions.base.serial);
	if (o.offlineLayer) {
		const args = layerNodeRequest(o.offlineLayer, {
			jobId: o.nodeBuildJobId as string,
			vmid: o.templateVmid as number,
			mediaStorage: MEDIA_STORAGE,
		});
		const cached = await deps.node.call<{ verified: boolean; sha256?: string }>(
			"layer.base",
			args,
		);
		if (!cached.verified) {
			const volid = `${MEDIA_STORAGE}:import/${name}`;
			const content = await deps.api.get<{ volid: string }[]>(
				`/nodes/${o.node}/storage/${MEDIA_STORAGE}/content`,
				{ content: "import" },
			);
			if (content.some((f) => f.volid === volid))
				await deps.node.call("media.remove", { names: [name] });
		}
	}
	await ensureMedia(deps, o.node, "import", name, img);
	if (o.offlineLayer) {
		const args = layerNodeRequest(o.offlineLayer, {
			jobId: o.nodeBuildJobId as string,
			vmid: o.templateVmid as number,
			mediaStorage: MEDIA_STORAGE,
		});
		const result = await deps.node.call<{ verified: boolean; sha256?: string }>(
			"layer.base",
			args,
		);
		if (!result.verified || result.sha256 !== versions.base.sha256)
			throw Error(
				"Official base hash verification failed on PVE before import",
			);
	}
	return name;
}

/**
 * The seed (an ISO 9660 image) travels as a raw disk, not as a CD: the first boot of the cloud
 * image has no initrd, so the CD drivers are modules that load after cloud-init has looked for
 * its seed; virtio-scsi and sd are built into the kernel (they mount the root).
 */
export const SEED_SLOT = "scsi1";

/** Name of the seed image in local:import. */
export function seedName(m: Manifest): string {
	return `umiak-seed-${m.buildId}.raw`;
}

export async function stageSeed(
	deps: BuildDeps,
	o: BuildOptions,
	p: Prepared,
	st: State,
): Promise<void> {
	const opt = <K extends keyof BuildOptions>(k: K) =>
		o[k] !== undefined ? { [k]: o[k] } : {};
	const input: SeedInput = {
		recipe: p.recipe,
		versions: p.versions,
		buildId: st.m.buildId,
		version: st.m.version,
		agentPackage: o.agentPackage,
		agentVersion: st.m.agentVersion,
		updateKeys: o.offlineLayer
			? Buffer.alloc(0)
			: readFileSync(o.updateKeysFile),
		manifestBase: guestManifest(st.m),
		...opt("umiakCli"),
		...opt("apiUrl"),
		...opt("tunnelUrl"),
		...opt("sshUserCa"),
	};
	const dir = mkdtempSync(join(tmpdir(), "umiak-tpl-seed-"));
	try {
		const name = seedName(st.m);
		const path = join(dir, "seed.iso");
		const files = o.offlineLayer
			? renderOfflineSeed(o.nodeBuildJobId as string, o.umiakCli)
			: renderSeed(input);
		// The seed must carry the bytes prepare verified, not a later version of the file.
		const pkg = files.get(SEED_AGENT_PACKAGE);
		if (
			!o.offlineLayer &&
			(pkg === undefined ||
				createHash("sha256").update(pkg).digest("hex") !== p.agentSha256)
		)
			throw new Error(
				`${o.agentPackage} changed after its signature was verified`,
			);
		deps.makeIso(files, path);
		const size = statSync(path).size;
		st.seedUploaded = true;
		deps.log(`uploading ${name} (${size} bytes)`);
		await upload(deps, o.node, "import", await fileSha256(path), {
			name,
			path,
			size,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function waitIpam(
	deps: BuildDeps,
	mac: string,
	pollMs: number,
): Promise<void> {
	const deadline = Date.now() + IPAM_TIMEOUT_MS;
	for (;;) {
		const entries = await deps.api.get<{ mac?: string; ip?: string }[]>(
			"/cluster/sdn/ipams/pve/status",
		);
		if (entries.some((e) => e.ip && e.mac?.toUpperCase() === mac.toUpperCase()))
			return;
		if (Date.now() >= deadline)
			throw new Error(`no IPAM address for ${mac} after ${IPAM_TIMEOUT_MS} ms`);
		await sleep(pollMs);
	}
}

export async function stageVm(
	deps: BuildDeps,
	o: BuildOptions,
	recipe: Recipe,
	image: string,
	st: State,
	save: Save,
): Promise<void> {
	const { api } = deps;
	const { vmid, mac } = await deps.allocator.allocateTemplate(recipe.vmids);
	if (isProtectedVmid(vmid) || (o.offlineLayer && vmid !== o.templateVmid))
		throw new Error(`allocator returned unexpected/protected VMID ${vmid}`);
	st.vmid = vmid;
	st.mac = mac;
	save({ pveVmid: vmid });
	deps.log(`VM ${vmid} ${st.m.vmName}`);
	const opts = Object.entries(DISK_OPTIONS)
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
	const upid = await api.post<string>(`/nodes/${o.node}/qemu`, {
		vmid,
		name: st.m.vmName,
		pool: o.pool,
		...recipe.hw,
		// The first boot of the cloud image has no initrd, so cloud-init's
		// generator can run before sr0 shows up and disable cloud-init. The
		// DMI hint makes ds-identify pick NoCloud; it then finds the seed.
		smbios1: BUILD_SMBIOS1,
		cores: recipe.buildVm.cores,
		memory: recipe.buildVm.memoryMb,
		balloon: 0,
		[recipe.disk.slot]:
			`${o.storage}:0,import-from=${MEDIA_STORAGE}:import/${image},${opts}`,
		[SEED_SLOT]: `${o.storage}:0,import-from=${MEDIA_STORAGE}:import/${seedName(st.m)}`,
		...(st.layerMedia
			? {
					scsi2: `${o.storage}:0,import-from=${MEDIA_STORAGE}:import/${st.layerMedia.mediaName},ro=1`,
				}
			: {}),
		net0: `virtio=${mac},bridge=${o.vnet},firewall=1${o.offlineLayer ? ",link_down=1" : ""}`,
		boot: `order=${recipe.disk.slot}`,
		description: `umiak-tpl build ${st.m.buildId}\ngit ${o.gitCommit}`,
	});
	await api.waitTask(o.node, upid, { timeoutMs: TASK_TIMEOUT_MS });
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	// Proxmox checks tag changes on /vms/<id> without the pool (GuestHelpers
	// assert_tag_permissions), and a VM being created is not in the pool yet:
	// tags in the create call fail for a pool-scoped token, so they come next.
	await api.put(`${vmPath}/config`, { tags: BUILD_TAG });
	const resized = await api.put(`${vmPath}/resize`, {
		disk: recipe.disk.slot,
		size: `${recipe.disk.sizeGb}G`,
	});
	if (isUpid(resized)) await api.waitTask(o.node, resized);
	// The IPAM entry appears with the VM on a DHCP vnet; ipfilter pins it.
	await waitIpam(deps, mac, deps.pollMs ?? DEFAULT_POLL_MS);
	await configureVmFirewall(api, o.node, vmid, mac, { ipfilter: true });
}

export async function stageBoot(
	deps: BuildDeps,
	o: BuildOptions,
	recipe: Recipe,
	io: GuestIo,
	st: State,
): Promise<void> {
	const vmid = st.vmid as number;
	await deps.ramGuard.reserve(vmid, recipe.buildVm.memoryMb);
	st.ramReserved = true;
	const upid = await deps.api.post<string>(
		`/nodes/${o.node}/qemu/${vmid}/status/start`,
	);
	await deps.api.waitTask(o.node, upid);
	// cloud-init installs the guest agent on the first boot.
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + PING_TIMEOUT_MS;
	while (!(await io.ping())) {
		if (Date.now() >= deadline)
			throw new Error(
				`guest agent did not answer within ${PING_TIMEOUT_MS} ms`,
			);
		await sleep(pollMs);
	}
	await mountSeed(io, o.offlineLayer ? "umiak-layer" : "cidata");
}

export function stepLog(
	deps: BuildDeps,
	o: BuildOptions,
	buildId: string,
	step: string,
): (chunk: string) => void {
	let file: string | undefined;
	if (o.logDir !== undefined) {
		const dir = join(o.logDir, buildId);
		mkdirSync(dir, { recursive: true });
		file = join(dir, `${step}.log`);
	}
	return (chunk) => {
		if (file !== undefined) appendFileSync(file, chunk);
		deps.stepOutput?.(step, chunk);
	};
}

export async function stageSteps(
	deps: BuildDeps,
	o: BuildOptions,
	recipe: Recipe,
	io: GuestIo,
	st: State,
): Promise<void> {
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	for (const step of recipe.steps) {
		st.step = step;
		if (o.offlineLayer && step === "90-cleanup")
			await runStep(io, {
				name: "offline-browser",
				script: "/mnt/seed/build/offline-cdp.sh",
				log: stepLog(deps, o, st.m.buildId, "offline-browser"),
				pollMs,
			});
		deps.log(`-- ${step}`);
		if (step === REBOOT_STEP) {
			await rebootGuest(io, {
				pollMs,
				...(o.offlineLayer ? { seedLabel: "umiak-layer" as const } : {}),
			});
			continue;
		}
		let script = `${STEP_DIR}/${step}.sh`;
		if (o.failStep === step) {
			await writeGuestFile(io, FAIL_STEP_SCRIPT, FAIL_STEP_BODY);
			script = FAIL_STEP_SCRIPT;
		}
		await runStep(io, {
			name: step,
			script,
			log: stepLog(deps, o, st.m.buildId, step),
			pollMs,
		});
	}
	delete st.step;
}

export async function vmStatus(
	deps: BuildDeps,
	node: string,
	vmid: number,
): Promise<string> {
	return (
		await deps.api.get<{ status: string }>(
			`/nodes/${node}/qemu/${vmid}/status/current`,
		)
	).status;
}

/** Guest poweroff through the agent; a hard stop if it is not off within 5 min. */
export async function shutdown(
	deps: BuildDeps,
	o: BuildOptions,
	vmid: number,
): Promise<void> {
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	try {
		await deps.api.post(`${vmPath}/agent/shutdown`);
	} catch (err) {
		// The agent often goes down before it answers.
		deps.log(`agent/shutdown: ${errorText(err)}; waiting for the stop`);
	}
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
	while ((await vmStatus(deps, o.node, vmid)) !== "stopped") {
		if (Date.now() >= deadline) {
			deps.log(
				`VM ${vmid} did not power off within ${SHUTDOWN_TIMEOUT_MS} ms: stopping it`,
			);
			const upid = await deps.api.post<string>(`${vmPath}/status/stop`);
			await deps.api.waitTask(o.node, upid);
			return;
		}
		await sleep(pollMs);
	}
}

/**
 * The build VM's firewall (ipfilter with its IPAM address, the umiak-egress rule) must not stay on
 * the template: a Proxmox clone copies it, and the copy then collides with the clone's own.
 */
export async function dropBuildFirewall(
	api: PveClient,
	vmPath: string,
): Promise<void> {
	const rules = await api.get<{ pos: number }[]>(`${vmPath}/firewall/rules`);
	for (const pos of rules.map((r) => r.pos).sort((a, b) => b - a))
		await api.delete(`${vmPath}/firewall/rules/${pos}`);
	const sets = await api.get<{ name: string }[]>(`${vmPath}/firewall/ipset`);
	for (const { name } of sets)
		await api.delete(`${vmPath}/firewall/ipset/${encodeURIComponent(name)}`, {
			force: 1,
		});
	await api.put(`${vmPath}/firewall/options`, { enable: 0 });
}

export async function stageTemplate(
	deps: BuildDeps,
	o: BuildOptions,
	st: State,
): Promise<void> {
	const vmid = st.vmid as number;
	const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
	await dropBuildFirewall(deps.api, vmPath);
	// force=1 destroys the seed disk instead of leaving it as unused0.
	await deps.api.put(`${vmPath}/unlink`, {
		idlist: st.layerMedia ? `${SEED_SLOT},scsi2` : SEED_SLOT,
		force: 1,
	});
	if (o.offlineLayer)
		await deps.api.put(`${vmPath}/config`, {
			net0: `virtio=${st.mac},bridge=${o.vnet},firewall=1`,
		});
	await deps.api.put(`${vmPath}/config`, { delete: "smbios1" });
	const r = await deps.api.post(`${vmPath}/template`);
	if (isUpid(r))
		await deps.api.waitTask(o.node, r, { timeoutMs: TASK_TIMEOUT_MS });
	await deps.node.call("media.remove", { names: [seedName(st.m)] });
	st.seedUploaded = false;
	// The umiak-tpl tag on the disk makes it a clone origin for umiak-node (as 599's).
	await deps.node.call("lv.tagTemplate", { vmid });
	await checkTemplateDisk(deps, `base-${vmid}-disk-0`, st);
	await deps.allocator.markActive(vmid);
}

/** A template disk this full kept the zero-fill: the free space was not trimmed. */
export const MAX_TEMPLATE_DISK_PCT = 40;

/**
 * Records the thin usage of the template's boot disk (LV `name`, base-<vmid>-disk-<k>) and fails
 * a build whose free space was not trimmed.
 */
export async function checkTemplateDisk(
	deps: BuildDeps,
	name: string,
	st: State,
): Promise<void> {
	// lv.list has no data percent for an inactive LV (a template); lv.usage activates it.
	const lv = await deps.node.call<{ sizeBytes: number; dataPercent: number }>(
		"lv.usage",
		{ name },
	);
	const usedGiB =
		Math.round(((lv.sizeBytes * lv.dataPercent) / 100 / 2 ** 30) * 10) / 10;
	st.m.diskUsedGiB = usedGiB;
	deps.log(`${name}: ${usedGiB} GiB used (${lv.dataPercent}%)`);
	if (lv.dataPercent > MAX_TEMPLATE_DISK_PCT)
		throw new Error(
			`${name} is ${lv.dataPercent}% allocated (over ${MAX_TEMPLATE_DISK_PCT}%): the free space was not trimmed`,
		);
}
