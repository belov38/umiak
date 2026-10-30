import { createHash } from "node:crypto";
import {
	appendFileSync,
	createReadStream,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Allocator,
	configureVmFirewall,
	type NodeOps,
	type PveClient,
	type UploadFile,
} from "@sbx/pve";
import { pveImageName } from "./image.ts";
import type { Manifest, VerifyResult } from "./manifest.ts";
import { REBOOT_STEP, type Recipe, type Versions } from "./recipe.ts";
import type { FileRegistry } from "./registry.ts";
import { type GuestIo, mountSeed, rebootGuest, runStep } from "./runner.ts";
import { writeGuestFile } from "./seal.ts";
import { renderSeed, SEED_AGENT_PACKAGE, type SeedInput } from "./seed.ts";
import { isProtectedVmid } from "./vmid-guard.ts";

// Stages of `sbx-tpl build` (spec S5 section 7.2); build.ts runs them in order and rolls back.

/** Storage of the base images and seed ISOs. */
export const MEDIA_STORAGE = "local";
export const BUILD_TAG = "sbx-tpl";
/** smbios1 of the build VM: serial "ds=nocloud" (base64). Removed with the seed ISO. */
export const BUILD_SMBIOS1 = `serial=${Buffer.from("ds=nocloud").toString("base64")},base64=1`;
export const DISK_OPTIONS = { discard: "on", iothread: "1", ssd: "1" };
const STEP_DIR = "/mnt/seed/build/steps";
/** `--fail-step` runs this script instead of the step (the seed stays unchanged). */
export const FAIL_STEP_SCRIPT = "/run/sbx-tpl-fail-step.sh";
const FAIL_STEP_BODY = 'echo "sbx-tpl: --fail-step"\nexit 1\n';

const MIN = 60_000;
export const TASK_TIMEOUT_MS = 30 * MIN;
const PING_TIMEOUT_MS = 10 * MIN;
const SHUTDOWN_TIMEOUT_MS = 5 * MIN;
const IPAM_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 2000;

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
	io: (vmid: number) => GuestIo;
	makeIso: (files: Map<string, string | Buffer>, out: string) => void;
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
}

export interface BuildOptions {
	slug: string;
	node: string;
	storage: string;
	pool: string;
	vnet: string;
	agentPackage: string;
	sbxCli?: string;
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
}

export type Stage =
	| "prepare"
	| "image"
	| "seed"
	| "vm"
	| "boot"
	| "steps"
	| "seal"
	| "template"
	| "verify"
	| "ready";

/** What the build created so far: the rollback removes exactly this. */
export interface State {
	m: Manifest;
	stage: Stage;
	step?: string;
	vmid?: number;
	mac?: string;
	seedUploaded: boolean;
	ramReserved: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const errorText = (err: unknown) =>
	err instanceof Error ? err.message : String(err);
const isUpid = (v: unknown): v is string =>
	typeof v === "string" && v.startsWith("UPID:");

async function fileSha256(path: string): Promise<string> {
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

async function upload(
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

/** Base image in local:import, uploaded only when it is not there with the same size. */
export async function stageImage(
	deps: BuildDeps,
	o: BuildOptions,
	versions: Versions,
): Promise<string> {
	const img = await deps.fetchImage(versions.base);
	const name = pveImageName(versions.base.serial);
	const size = statSync(img.path).size;
	const have = (
		await deps.api.get<{ volid: string; size?: number }[]>(
			`/nodes/${o.node}/storage/${MEDIA_STORAGE}/content`,
			{ content: "import" },
		)
	).find((f) => f.volid === `${MEDIA_STORAGE}:import/${name}`);
	if (have?.size === size) {
		deps.log(`${MEDIA_STORAGE}:import/${name} is present`);
		return name;
	}
	if (have) {
		// A partial earlier upload: an upload never overwrites.
		deps.log(
			`${MEDIA_STORAGE}:import/${name} has ${have.size} bytes, want ${size}: replacing`,
		);
		await deps.node.call("media.remove", { names: [name] });
	}
	deps.log(`uploading ${name} (${size} bytes)`);
	await upload(deps, o.node, "import", img.sha256, {
		name,
		path: img.path,
		size,
	});
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
	return `sbx-seed-${m.buildId}.raw`;
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
		manifestBase: guestManifest(st.m),
		...opt("sbxCli"),
		...opt("apiUrl"),
		...opt("tunnelUrl"),
		...opt("sshUserCa"),
	};
	const dir = mkdtempSync(join(tmpdir(), "sbx-tpl-seed-"));
	try {
		const name = seedName(st.m);
		const path = join(dir, "seed.iso");
		const files = renderSeed(input);
		// The seed must carry the bytes prepare verified, not a later version of the file.
		const pkg = files.get(SEED_AGENT_PACKAGE);
		if (
			pkg === undefined ||
			createHash("sha256").update(pkg).digest("hex") !== p.agentSha256
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

async function waitIpam(
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
	save: (patch: Partial<Manifest>) => void,
): Promise<void> {
	const { api } = deps;
	const { vmid, mac } = await deps.allocator.allocateTemplate();
	if (isProtectedVmid(vmid))
		throw new Error(`allocator returned protected VMID ${vmid}`);
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
		net0: `virtio=${mac},bridge=${o.vnet},firewall=1`,
		boot: `order=${recipe.disk.slot}`,
		description: `sbx-tpl build ${st.m.buildId}\ngit ${o.gitCommit}`,
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
	await mountSeed(io);
}

function stepLog(
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
		deps.log(`-- ${step}`);
		if (step === REBOOT_STEP) {
			await rebootGuest(io, { pollMs });
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
 * The build VM's firewall (ipfilter with its IPAM address, the sbx-egress rule) must not stay on
 * the template: a Proxmox clone copies it, and the copy then collides with the clone's own.
 */
async function dropBuildFirewall(
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
	await deps.api.put(`${vmPath}/unlink`, { idlist: SEED_SLOT, force: 1 });
	await deps.api.put(`${vmPath}/config`, { delete: "smbios1" });
	const r = await deps.api.post(`${vmPath}/template`);
	if (isUpid(r))
		await deps.api.waitTask(o.node, r, { timeoutMs: TASK_TIMEOUT_MS });
	await deps.node.call("media.remove", { names: [seedName(st.m)] });
	st.seedUploaded = false;
	await deps.allocator.markActive(vmid);
}
