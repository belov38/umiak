import { existsSync } from "node:fs";
import { familyForTunnelUrl, PveApiError, type PveClient } from "@umiak/pve";
import { stringify as stringifyYaml } from "yaml";
import { verifyAgentPackage } from "./agent-package.ts";
import type { BuildError, Manifest } from "./manifest.ts";
import {
	type LinuxRecipe,
	loadRecipe,
	loadVerifyScript,
	loadVersions,
	REBOOT_STEP,
	type Recipe,
	recipeDigest,
} from "./recipe.ts";
import { newBuildId } from "./registry.ts";
import type { GuestIo } from "./runner.ts";
import { StepFailedError, StepTimeoutError } from "./runner.ts";
import { collectFacts, sealGuest, writeGuestFile } from "./seal.ts";
import {
	BUILD_TAG,
	type BuildApi,
	type BuildDeps,
	type BuildOptions,
	DISK_OPTIONS,
	errorText,
	guestManifest,
	type Prepared,
	type Save,
	type Stage,
	type State,
	seedName,
	shutdown,
	stageBoot,
	stageImage,
	stageSeed,
	stageSteps,
	stageTemplate,
	stageVm,
	TASK_TIMEOUT_MS,
	vmStatus,
} from "./stages.ts";
import { isProtectedVmid } from "./vmid-guard.ts";
import {
	buildIsoName,
	prepareWindows,
	windowsStages,
} from "./windows/stages.ts";

export {
	type BuildApi,
	type BuildDeps,
	type BuildOptions,
	type ConnectOptions,
	FAIL_STEP_SCRIPT,
} from "./stages.ts";

// `umiak-tpl build`: base image to Proxmox template (spec S5 section 7.2)

const GUEST_MANIFEST = "/etc/umiak-template/build.json";

export class BuildFailedError extends Error {
	readonly manifest: Manifest;
	constructor(manifest: Manifest, cause: unknown) {
		const e = manifest.error;
		super(
			`build ${manifest.buildId} failed at ${e?.stage}${e?.step ? ` (step ${e.step})` : ""}: ${e?.message}`,
			{ cause },
		);
		this.name = "BuildFailedError";
		this.manifest = manifest;
	}
}

/** Stage 1 checks: everything that can be wrong before the build is recorded. */
function prepare(
	deps: BuildDeps,
	o: BuildOptions,
	recipe: LinuxRecipe,
): Prepared {
	for (const [flag, v] of [
		["--iso", o.iso],
		["--iso-sha256", o.isoSha256],
		["--virtio-iso", o.virtioIso],
		["--virtio-sha256", o.virtioSha256],
		["--accept-iso-sha256", o.acceptIsoSha256 ? true : undefined],
		["--edition", o.edition],
		["--product-key-file", o.productKeyFile],
	] as const)
		if (v !== undefined)
			throw new Error(
				`${flag} is only for iso-install recipes; "${o.slug}" is a cloud image`,
			);
	const versions = loadVersions(recipe);
	const scriptSteps = recipe.steps.filter((s) => s !== REBOOT_STEP);
	if (o.failStep !== undefined && !scriptSteps.includes(o.failStep))
		throw new Error(
			`--fail-step ${o.failStep}: not a script step of "${o.slug}" (${scriptSteps.join(", ")})`,
		);
	// Same rules as the per-VM smbios family the worker sets (wss://, host, length).
	if (o.tunnelUrl !== undefined) familyForTunnelUrl(o.tunnelUrl);
	if (o.apiUrl !== undefined && !/^https?:\/\/[^/]/.test(o.apiUrl))
		throw new Error(`--api-url must be an http(s) URL: ${o.apiUrl}`);
	for (const [flag, file] of [
		["--umiak-cli", o.umiakCli],
		["--ssh-user-ca", o.sshUserCa],
	] as const)
		if (file !== undefined && !existsSync(file))
			throw new Error(`${flag}: ${file} not found`);
	const verifyScript = loadVerifyScript(
		o.templatesDir,
		recipe.verify,
		recipe.os,
	);
	const agent = verifyAgentPackage(o.agentPackage, o.updateKeysFile);

	const now = deps.now();
	const version = deps.registry.claimVersion(o.slug, now);
	const manifest: Manifest = {
		buildId: newBuildId(),
		templateSlug: o.slug,
		version,
		os: recipe.os,
		status: "building",
		node: o.node,
		storage: o.storage,
		pveVmid: null,
		vmName: `umiak-tpl-${o.slug}-${version.replace(".", "-")}`,
		gitCommit: o.gitCommit,
		recipeDigest: recipeDigest(recipe),
		base: {
			distro: recipe.source.distro,
			release: recipe.source.release,
			flavor: recipe.source.flavor,
			serial: versions.base.serial,
			sha256: versions.base.sha256,
		},
		apt: { snapshot: versions.apt.snapshot },
		...(versions.desktop
			? {
					desktop: {
						pins: versions.desktop,
						sources: {
							sunshine: `https://github.com/LizardByte/Sunshine/tree/v${versions.desktop.sunshine.version}`,
							moonlight_web: `https://github.com/MrCreativ3001/moonlight-web-stream/tree/v${versions.desktop.moonlight_web.version}`,
							cua_driver: `https://github.com/trycua/cua/tree/cua-driver-rs-v${versions.desktop.cua_driver.version}`,
						},
					},
				}
			: {}),
		kernel: null,
		systemd: null,
		packages: {},
		tools: {},
		agentVersion: agent.version,
		defaultTunnelUrl: o.tunnelUrl ?? null,
		hw: { ...recipe.hw, cloudinit: recipe.cloudinit },
		diskLayout: {
			[recipe.disk.slot]: { size: `${recipe.disk.sizeGb}G`, ...DISK_OPTIONS },
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
		verifyScript,
		manifest,
		agentSha256: agent.sha256,
	};
}

/**
 * Proxmox client that fails every call once `signal` is aborted, checked before and after the
 * call. A call that started a task (returned a UPID) is not failed afterwards, and waitTask is
 * not checked before: the task finishes before the abort takes effect, so the rollback does
 * not meet a VM locked by a running task.
 */
export function guardApi(api: BuildApi, signal: AbortSignal): BuildApi {
	const g =
		<A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
		async (...a: A): Promise<R> => {
			signal.throwIfAborted();
			const r = await fn(...a);
			if (!isUpid(r)) signal.throwIfAborted();
			return r;
		};
	return {
		get: g((p, q) => api.get(p, q)),
		post: g((p, q) => api.post(p, q)),
		put: g((p, q) => api.put(p, q)),
		delete: g((p, q) => api.delete(p, q)),
		waitTask: async (n, u, o) => {
			await api.waitTask(n, u, o);
			signal.throwIfAborted();
		},
		upload: g((p, f, file) => api.upload(p, f, file)),
	} as BuildApi;
}

const isUpid = (v: unknown) => typeof v === "string" && v.startsWith("UPID:");

function guardIo(io: GuestIo, signal: AbortSignal): GuestIo {
	const g =
		<A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
		async (...a: A): Promise<R> => {
			signal.throwIfAborted();
			const r = await fn(...a);
			signal.throwIfAborted();
			return r;
		};
	return {
		exec: g((c: string[], o?: { input?: string; timeoutMs?: number }) =>
			io.exec(c, o),
		),
		readFile: g((p: string, off: number, n: number) => io.readFile(p, off, n)),
		ping: g(() => io.ping()),
	};
}

/** A prepared build: its first manifest and the stages up to the template. */
interface Job {
	manifest: Manifest;
	stages(
		run: BuildDeps,
		st: State,
		save: Save,
		enter: (stage: Stage) => void,
	): Promise<void>;
}

function linuxJob(deps: BuildDeps, o: BuildOptions, recipe: LinuxRecipe): Job {
	const p = prepare(deps, o, recipe);
	return {
		manifest: p.manifest,
		async stages(run, st, save, enter) {
			enter("image");
			const image = await stageImage(run, o, p.versions);
			enter("seed");
			await stageSeed(run, o, p, st);
			enter("vm");
			await stageVm(run, o, p.recipe, image, st, save);
			const vmid = st.vmid as number;
			const io = run.io(vmid);
			enter("boot");
			await stageBoot(run, o, p.recipe, io, st);
			enter("steps");
			await stageSteps(run, o, p.recipe, io, st);
			enter("seal");
			save(await collectFacts(io, p.verifyScript));
			await writeGuestFile(
				io,
				GUEST_MANIFEST,
				`${JSON.stringify(guestManifest(st.m), null, 2)}\n`,
			);
			await sealGuest(io);
			await shutdown(run, o, vmid);
			run.ramGuard.release(vmid);
			st.ramReserved = false;
			enter("template");
			await stageTemplate(run, o, st);
			if (st.m.diskUsedGiB !== undefined)
				save({ diskUsedGiB: st.m.diskUsedGiB });
		},
	};
}

/** Source kind decides the pipeline; recipe.ts pairs iso-install with os windows. */
function newJob(deps: BuildDeps, o: BuildOptions, recipe: Recipe): Job {
	if (recipe.os === "windows" && recipe.source.kind === "iso-install") {
		const p = prepareWindows(deps, o, recipe);
		return {
			manifest: p.manifest,
			stages: (run, st, save, enter) =>
				windowsStages(run, o, p, st, save, enter),
		};
	}
	if (recipe.os === "linux") return linuxJob(deps, o, recipe);
	throw new Error(`recipe "${o.slug}": unsupported source`);
}

export async function buildTemplate(
	deps: BuildDeps,
	o: BuildOptions,
): Promise<Manifest> {
	const recipe = loadRecipe(o.templatesDir, o.slug);
	// Persist the canonical recipe slug even when invoked through a legacy alias.
	o = { ...o, slug: recipe.slug };
	if (o.templateVmid !== undefined) {
		if (isProtectedVmid(o.templateVmid))
			throw new Error("Explicit template VMID is protected");
		recipe.vmids = [o.templateVmid];
	}
	const job = newJob(deps, o, recipe);
	deps.registry.create(job.manifest);
	const st: State = {
		m: job.manifest,
		stage: "prepare",
		seedUploaded: false,
		ramReserved: false,
	};
	const save = (patch: Partial<Manifest>, unset: (keyof Manifest)[] = []) => {
		st.m = deps.registry.update(st.m.buildId, patch, unset);
	};
	const finished = () => {
		const at = deps.now();
		return {
			finishedAt: at.toISOString(),
			durationS: Math.round((at.getTime() - Date.parse(st.m.startedAt)) / 1000),
		};
	};
	const enter = (stage: Stage) => {
		st.stage = stage;
		deps.log(`== ${stage}`);
	};
	deps.log(`build ${st.m.buildId}: ${st.m.templateSlug} ${st.m.version}`);
	deps.onStart?.(st.m);
	// Stages run on guarded clients; the rollback uses the plain ones.
	const { signal } = deps;
	const run: BuildDeps = signal
		? {
				...deps,
				api: guardApi(deps.api, signal),
				io: (vmid) => guardIo(deps.io(vmid), signal),
			}
		: deps;

	try {
		await job.stages(run, st, save, enter);
		if (!o.noVerify) {
			enter("verify");
			const v = await run.verify(st.m, {
				...(o.connect !== undefined ? { connect: o.connect } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			signal?.throwIfAborted();
			save({
				verify: v,
				...(v.license !== undefined ? { license: v.license } : {}),
			});
			if (!v.ok) {
				const red = v.checks
					.filter((c) => c.status === "FAIL")
					.map((c) => c.id);
				throw new Error(`verification failed: ${red.join(", ") || "not ok"}`);
			}
		}
		enter("ready");
		save({ status: "ready", ...finished() }, ["error"]);
		return st.m;
	} catch (err) {
		const failed: Partial<Manifest> = {
			status: "failed",
			error: buildError(st.stage, st.step, err),
			...finished(),
		};
		st.m = { ...st.m, ...failed };
		deps.log(`failed at ${st.stage}: ${errorText(err)}`);
		try {
			save(failed);
		} catch (saveErr) {
			deps.log(`recording the failure: ${errorText(saveErr)}`);
		} finally {
			if (o.keepOnFailure) {
				deps.log("--keep-on-failure: leaving the VM and the ISO");
				await dropBuildIso(deps, o, st);
			} else await rollback(deps, o, st);
			if (st.ramReserved && st.vmid !== undefined)
				deps.ramGuard.release(st.vmid);
		}
		throw new BuildFailedError(st.m, err);
	}
}

function buildError(
	stage: Stage,
	step: string | undefined,
	err: unknown,
): BuildError {
	const message = errorText(err);
	if (err instanceof StepFailedError || err instanceof StepTimeoutError)
		return { stage, step: err.step, message, tail: err.tail };
	return step !== undefined ? { stage, step, message } : { stage, message };
}

/** VM config, or undefined when the VM does not exist. */
async function readConfig(
	api: PveClient,
	path: string,
): Promise<Record<string, string> | undefined> {
	try {
		return await api.get<Record<string, string>>(`${path}/config`);
	} catch (err) {
		if (
			err instanceof PveApiError &&
			(err.status === 403 ||
				err.status === 404 ||
				/does not exist/.test(err.message))
		)
			return undefined;
		throw err;
	}
}

/** Whether a VM config is this build's VM: its name and the build tag (or the build id). */
function isBuildVm(cfg: Record<string, string>, m: Manifest): boolean {
	const tags = (cfg.tags ?? "").split(/[;,]/);
	return (
		cfg.name === m.vmName &&
		(tags.includes(BUILD_TAG) ||
			// Created, but the tag call after the create failed.
			(cfg.description ?? "").includes(`umiak-tpl build ${m.buildId}`))
	);
}

/**
 * Removes what this build created: its VM (only if name and tag are the build's), the seed
 * ISO and the VMID lease. The base image stays as a cache. Errors are logged; the build
 * error is what the caller reports.
 */
async function rollback(
	deps: BuildDeps,
	o: BuildOptions,
	st: State,
): Promise<void> {
	const warn = (what: string, err: unknown) =>
		deps.log(`rollback: ${what}: ${errorText(err)}`);
	let vmGone = true;
	if (st.vmid !== undefined && isProtectedVmid(st.vmid)) {
		deps.log(`rollback: VMID ${st.vmid} is protected: left alone`);
		vmGone = false;
	} else if (st.vmid !== undefined) {
		const vmid = st.vmid;
		const vmPath = `/nodes/${o.node}/qemu/${vmid}`;
		try {
			const cfg = await readConfig(deps.api, vmPath);
			const tags = (cfg?.tags ?? "").split(/[;,]/);
			if (cfg === undefined) {
				deps.log(`rollback: VM ${vmid} does not exist`);
			} else if (
				cfg.name !== st.m.vmName ||
				!(
					tags.includes(BUILD_TAG) ||
					// Created, but the tag call after the create failed.
					(cfg.description ?? "").includes(`umiak-tpl build ${st.m.buildId}`)
				)
			) {
				deps.log(
					`rollback: VM ${vmid} is "${cfg.name}" with tags "${cfg.tags ?? ""}", not this build's: left alone`,
				);
			} else {
				if ((await vmStatus(deps, o.node, vmid)) !== "stopped") {
					const upid = await deps.api.post<string>(`${vmPath}/status/stop`);
					await deps.api.waitTask(o.node, upid);
				}
				const upid = await deps.api.delete<string>(vmPath, {
					purge: 1,
					"destroy-unreferenced-disks": 1,
				});
				await deps.api.waitTask(o.node, upid, { timeoutMs: TASK_TIMEOUT_MS });
				deps.log(`rollback: deleted VM ${vmid}`);
				if (st.mac !== undefined)
					await deps.node
						.call("dhcp.release", { mac: st.mac })
						.catch((err: unknown) => warn(`DHCP lease of ${st.mac}`, err));
			}
		} catch (err) {
			vmGone = false;
			warn(`deleting VM ${vmid}`, err);
		}
	}
	if (st.seedUploaded) {
		try {
			await deps.node.call("media.remove", { names: [seedName(st.m)] });
		} catch (err) {
			warn(`removing ${seedName(st.m)}`, err);
		}
	}
	// Build and offline ISOs only: the user's ISO and virtio-win stay.
	if (st.isos !== undefined && st.isos.length > 0) {
		try {
			await deps.node.call("media.remove", { names: st.isos });
			st.isos = [];
		} catch (err) {
			warn(`removing ${st.isos.join(", ")}`, err);
		}
	}
	// A VMID whose VM could not be deleted keeps its lease until `umiak-tpl cleanup`.
	if (st.vmid !== undefined && vmGone) {
		try {
			await deps.allocator.release(st.vmid);
		} catch (err) {
			warn(`releasing VMID ${st.vmid}`, err);
		}
	}
}

/**
 * --keep-on-failure keeps the VM, but not the build ISO: it holds the build password. It is
 * ejected from the kept VM first, so the VM can still start.
 */
async function dropBuildIso(
	deps: BuildDeps,
	o: BuildOptions,
	st: State,
): Promise<void> {
	const name = buildIsoName(st.m);
	if (!st.isos?.includes(name)) return;
	const warn = (what: string, err: unknown) =>
		deps.log(`--keep-on-failure: ${what}: ${errorText(err)}`);
	if (st.vmid !== undefined && !isProtectedVmid(st.vmid)) {
		const vmPath = `/nodes/${o.node}/qemu/${st.vmid}`;
		try {
			const cfg = await readConfig(deps.api, vmPath);
			if (cfg !== undefined && !isBuildVm(cfg, st.m))
				deps.log(
					`--keep-on-failure: VM ${st.vmid} is "${cfg.name}", not this build's: ${name} not ejected`,
				);
			else
				for (const [k, v] of Object.entries(cfg ?? {}))
					if (/^(ide|sata|scsi)\d+$/.test(k) && v.includes(`iso/${name}`))
						await deps.api.put(`${vmPath}/config`, { [k]: "none,media=cdrom" });
		} catch (err) {
			warn(`ejecting ${name}`, err);
		}
	}
	try {
		await deps.node.call("media.remove", { names: [name] });
		st.isos = st.isos.filter((n) => n !== name);
	} catch (err) {
		warn(`removing ${name}`, err);
	}
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The `umiak-admin template register` call for a ready build (S6 section 14.3). */
export function registerCommand(m: Manifest): string {
	return [
		"umiak-admin template register",
		`--template ${m.templateSlug}`,
		`--version ${m.version}`,
		`--os ${m.os}`,
		`--node ${m.node}`,
		`--storage ${m.storage}`,
		`--pve-vmid ${m.pveVmid}`,
		`--boot-timeout-s ${m.bootTimeoutS}`,
		`--agent-version ${m.agentVersion}`,
		`--disk-layout ${shellQuote(JSON.stringify(m.diskLayout))}`,
		`--hw ${shellQuote(JSON.stringify(m.hw))}`,
	].join(" ");
}

/** A `topology.templateBuilds` list entry for deploy/compose/config/umiak.yaml. */
export function topologySnippet(m: Manifest): string {
	return stringifyYaml([
		{
			templateSlug: m.templateSlug,
			version: m.version,
			os: m.os,
			node: m.node,
			storage: m.storage,
			pveVmid: m.pveVmid,
			bootTimeoutS: m.bootTimeoutS,
			agentVersion: m.agentVersion,
			diskLayout: m.diskLayout,
			hw: m.hw,
		},
	]);
}
