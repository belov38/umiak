import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { familyForTunnelUrl, PveApiError, type PveClient } from "@sbx/pve";
import { stringify as stringifyYaml } from "yaml";
import { verifyAgentPackage } from "./agent-package.ts";
import type { BuildError, Manifest } from "./manifest.ts";
import {
	loadRecipe,
	loadVersions,
	REBOOT_STEP,
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

export {
	type BuildApi,
	type BuildDeps,
	type BuildOptions,
	type ConnectOptions,
	FAIL_STEP_SCRIPT,
} from "./stages.ts";

// `sbx-tpl build`: base image to Proxmox template (spec S5 section 7.2)

const GUEST_MANIFEST = "/etc/sbx-template/build.json";

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
function prepare(deps: BuildDeps, o: BuildOptions): Prepared {
	const recipe = loadRecipe(o.templatesDir, o.slug);
	if (recipe.os !== "linux")
		throw new Error(
			`recipe "${o.slug}" is for ${recipe.os}; only linux is supported`,
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
		["--sbx-cli", o.sbxCli],
		["--ssh-user-ca", o.sshUserCa],
	] as const)
		if (file !== undefined && !existsSync(file))
			throw new Error(`${flag}: ${file} not found`);
	const verifyScript = readFileSync(
		join(o.templatesDir, recipe.verify, "verify.sh"),
		"utf8",
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
		vmName: `sbx-tpl-${o.slug}-${version.replace(".", "-")}`,
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

export async function buildTemplate(
	deps: BuildDeps,
	o: BuildOptions,
): Promise<Manifest> {
	const p = prepare(deps, o);
	deps.registry.create(p.manifest);
	const st: State = {
		m: p.manifest,
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
		deps.ramGuard.release(vmid);
		st.ramReserved = false;
		enter("template");
		await stageTemplate(run, o, st);
		if (!o.noVerify) {
			enter("verify");
			const v = await run.verify(st.m, {
				...(o.connect !== undefined ? { connect: o.connect } : {}),
				...(signal !== undefined ? { signal } : {}),
			});
			signal?.throwIfAborted();
			save({ verify: v });
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
			if (o.keepOnFailure)
				deps.log("--keep-on-failure: leaving the VM and the ISO");
			else await rollback(deps, o, st);
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
					(cfg.description ?? "").includes(`sbx-tpl build ${st.m.buildId}`)
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
	// A VMID whose VM could not be deleted keeps its lease until `sbx-tpl cleanup`.
	if (st.vmid !== undefined && vmGone) {
		try {
			await deps.allocator.release(st.vmid);
		} catch (err) {
			warn(`releasing VMID ${st.vmid}`, err);
		}
	}
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The `sbx-admin template register` call for a ready build (S6 section 14.3). */
export function registerCommand(m: Manifest): string {
	return [
		"sbx-admin template register",
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

/** A `topology.templateBuilds` list entry for deploy/compose/config/sbx.yaml. */
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
