// Serial, durable S5 build jobs. Never retire or rebuild an occupied template slot.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { validateUploadedIso } from "./setup-iso.mjs";

import { templateRange, validateTemplateRange } from "./setup-vmids.mjs";

const exec = promisify(execFile);
export function buildInvocation(
	slug,
	state,
	secretsDir,
	origin,
	assetsDir,
	jobId = "build",
	input = {},
) {
	if (slug === "windows-desktop") slug = "windows";
	if (!["linux", "linux-desktop", "windows"].includes(slug))
		throw new Error("Unknown operating system");
	const slot = input.templateVmid;
	const range = templateRange(state);
	validateTemplateRange({ ...state.steps.limits.data, ...range });
	if (
		!Number.isInteger(slot) ||
		slot < range.templateVmidMin ||
		slot > range.templateVmidMax
	)
		throw new Error(
			"Allocate a free VMID in the configured template range before building",
		);
	const connection = state.steps.connection.data;
	const limits = state.steps.limits.data;
	const network = state.steps.network.data;
	const directory = join(secretsDir, "template-builds", jobId);
	const agentPackage = join(
		directory,
		`umiak-agent-${slug.startsWith("windows") ? "windows" : "linux"}.tar`,
	);
	const env = {
		...process.env,
		UMIAK_RECIPE_DIR: input.recipeDirectory || "",
		UMIAK_PVE_URL: connection.apiUrl,
		UMIAK_PVE_TOKEN_ID: connection.tokenId,
		UMIAK_PVE_TOKEN_SECRET_FILE: join(secretsDir, "pve-token"),
		UMIAK_PVE_CA_FILE: join(secretsDir, "pve-root-ca.pem"),
		UMIAK_PVE_TLS_NAME: connection.tlsName,
		UMIAK_PVE_NODE: connection.node,
		UMIAK_NODE_SSH_HOST: connection.sshHost,
		UMIAK_NODE_SSH_KEY_FILE: join(secretsDir, "umiak-node_ed25519"),
		UMIAK_NODE_SSH_KNOWN_HOSTS: join(secretsDir, "known_hosts"),
		UMIAK_VMID_RANGE: `${limits.vmidMin}-${limits.vmidMax}`,
		UMIAK_TEMPLATE_VMID_RANGE: `${slot}-${slot}`,
		UMIAK_TEMPLATE_VMID: "0",
		UMIAK_TEMPLATE_PROVIDER_ID: limits.providerId,
		UMIAK_TEMPLATE_BUILD_JOB_ID: jobId,
		UMIAK_CLUSTER_ID: "1",
		UMIAK_PVE_STORAGE: limits.storage,
		UMIAK_TEMPLATE_RAM_CAP_MB: String(limits.ramCapMb ?? 8192),
		UMIAK_PVE_MEDIA_STORAGE:
			input.mediaStorage || state.mediaStorage || "local",
		UMIAK_PVE_VNET: "umiak0",
		UMIAK_GUEST_SUBNET: network.guestSubnet || "10.88.0.0/24",
		UMIAK_PVE_POOL: "umiak",
		UMIAK_STATE_DB: join(directory, "state.db"),
		UMIAK_TEMPLATE_REGISTRY: join(secretsDir, "template-registry"),
		UMIAK_IMAGE_CACHE: join(secretsDir, "image-cache"),
		UMIAK_TEMPLATE_LOG_DIR: join(directory, "logs"),
		// Public keys: verify the package and become the first-install trust
		// anchor of the agent in the template (update-keys.pub in the seed).
		UMIAK_UPDATE_KEYS_FILE: join(
			secretsDir,
			"update-signing",
			"update-keys.pub",
		),
		// The per-install private signing key: the raw-disk scan of verify
		// looks for it on the template disk.
		UMIAK_UPDATE_SIGNING_KEY: join(secretsDir, "update-signing", "ed25519.key"),
	};
	const args = [
		"apps/template-builder/src/main.ts",
		"build",
		slug,
		"--node",
		connection.node,
		"--template-vmid",
		String(slot),
		"--agent-package",
		agentPackage,
		"--umiak-cli",
		join(assetsDir, "umiak-linux-x64"),
		"--api-url",
		origin,
		"--tunnel-url",
		network.tunnelUrl,
	];
	if (slug.startsWith("windows")) {
		if (
			!validateUploadedIso(input.iso) ||
			!/^[a-fA-F0-9]{64}$/.test(input.isoSha256 || "")
		)
			throw new Error("Windows needs an uploaded ISO file name and its SHA256");
		const [storage, name] = input.iso.includes(":iso/")
			? input.iso.split(":iso/")
			: [null, input.iso];
		if (storage && storage !== env.UMIAK_PVE_MEDIA_STORAGE)
			throw Error("Use the selected node configured media storage");
		args.push("--iso", name, "--iso-sha256", input.isoSha256);
		if (input.virtioIso)
			args.push(
				"--virtio-iso",
				input.virtioIso,
				"--virtio-sha256",
				input.virtioSha256,
			);
		if (input.edition) args.push("--edition", String(input.edition));
	}
	return {
		command: process.execPath,
		args,
		env,
		directory,
		agentPackage,
		slot,
		slug,
	};
}
async function packageAgent(invocation, secretsDir, assetsDir) {
	const keyDir = join(secretsDir, "update-signing");
	await mkdir(keyDir, { recursive: true, mode: 0o700 });
	try {
		await readFile(join(keyDir, "ed25519.key"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const result = await exec("/umiak-release", [
			"keygen",
			"--out",
			keyDir,
			"--comment",
			"umiak-quickstart",
		]);
		await writeFile(join(keyDir, "update-keys.pub"), result.stdout, {
			mode: 0o600,
		});
	}
	const os = invocation.slug.startsWith("windows") ? "windows" : "linux";
	const gatewayCa =
		process.env.UMIAK_QUICKSTART_GATEWAY_CA || "/gateway-secrets/ca.pem";
	await exec("/umiak-release", [
		"pack",
		"--version",
		"0.1.0+quickstart",
		"--os",
		os,
		"--arch",
		"amd64",
		"--binary",
		join(assetsDir, `umiak-agent-${os}-amd64${os === "windows" ? ".exe" : ""}`),
		"--tunnel-ca",
		gatewayCa,
		"--update-keys",
		join(keyDir, "update-keys.pub"),
		"--key",
		join(keyDir, "ed25519.key"),
		"--out",
		invocation.agentPackage,
		"--skip-version-check",
	]);
	await exec("/umiak-release", [
		"verify",
		"--keys",
		join(keyDir, "update-keys.pub"),
		invocation.agentPackage,
	]);
}
export async function runTemplateBuild(
	invocation,
	{
		secretsDir,
		assetsDir,
		launch = spawn,
		onProgress = async () => {},
		existingVersions = [],
	} = {},
) {
	await mkdir(invocation.directory, { recursive: true, mode: 0o700 });
	await mkdir(invocation.env.UMIAK_TEMPLATE_REGISTRY, {
		recursive: true,
		mode: 0o700,
	});
	for (const row of existingVersions) {
		if (
			/^[a-z0-9-]+$/.test(row.template_slug) &&
			/^\d{8}\.\d+$/.test(row.version)
		) {
			await writeFile(
				join(
					invocation.env.UMIAK_TEMPLATE_REGISTRY,
					`${row.template_slug}@${row.version}.claim`,
				),
				"",
				{ mode: 0o600 },
			);
		}
	}
	await packageAgent(invocation, secretsDir, assetsDir);
	const token = (await readFile(join(secretsDir, "pve-token"), "utf8")).trim();
	await new Promise((resolvePromise, reject) => {
		const child = launch(invocation.command, invocation.args, {
			cwd: resolve(import.meta.dirname, "../../.."),
			env: invocation.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let tail = "";
		const append = (chunk) => {
			const safe = String(chunk).replaceAll(token, "[redacted]");
			tail = (tail + safe).slice(-12000);
			void onProgress(safe);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		const stop = () => child.kill("SIGINT");
		process.once("SIGTERM", stop);
		child.on("error", reject);
		child.on("close", (code) => {
			process.removeListener("SIGTERM", stop);
			if (code !== 0)
				reject(
					new Error(
						`Template builder exited ${code}: ${tail.replaceAll(token, "[redacted]")}`,
					),
				);
			else resolvePromise();
		});
	});
	return readBuiltManifest(invocation);
}

export async function readBuiltManifest(invocation) {
	const jobId = invocation.env.UMIAK_TEMPLATE_BUILD_JOB_ID;
	if (!jobId) throw Error("Template build job identity is required");
	const registry = invocation.env.UMIAK_TEMPLATE_REGISTRY;
	const matches = [];
	for (const file of await readdir(registry)) {
		if (!file.endsWith(".json") || file.startsWith(".")) continue;
		const manifest = JSON.parse(await readFile(join(registry, file), "utf8"));
		if (
			manifest.nodeBuildJobId === jobId &&
			manifest.node === invocation.env.UMIAK_PVE_NODE &&
			manifest.templateSlug === invocation.slug &&
			Number(manifest.pveVmid) === invocation.slot &&
			manifest.status === "ready" &&
			manifest.verify?.ok
		)
			matches.push(manifest);
	}
	if (matches.length !== 1)
		throw Error(
			"Template builder did not produce exactly one verified ready manifest for this job",
		);
	return matches[0];
}

export class TemplateBuildJobs {
	constructor({
		store,
		run,
		validate = async () => {},
		register = async () => {},
		replicate = async () => {},
		copyExisting = async () => false,
		reserve = async () => {},
		interrupt = async () => {},
		finish = async () => {},
		release = async () => {},
		logDir,
	}) {
		this.store = store;
		// Full job output on disk; the state keeps only the tail shown inline.
		this.logDir = logDir;
		this.run = run;
		this.validate = validate;
		this.register = register;
		this.replicate = replicate;
		this.copyExisting = copyExisting;
		this.reserve = reserve;
		this.interrupt = interrupt;
		this.finish = finish;
		this.release = release;
		this.pending = Promise.resolve();
	}
	logPath(jobId) {
		if (!this.logDir || !/^[a-f0-9]{24}$/.test(jobId || "")) return null;
		return join(this.logDir, `${jobId}.log`);
	}
	async appendLog(jobId, text) {
		const file = this.logPath(jobId);
		if (file) {
			await mkdir(this.logDir, { recursive: true, mode: 0o700 });
			await appendFile(file, text, { mode: 0o600 });
		}
		await this.update((state) => {
			if (state.buildJob?.id === jobId)
				state.buildJob.log = ((state.buildJob.log || "") + text).slice(-24000);
		});
	}
	async update(fn) {
		const action = async () => {
			const state = await this.store.read();
			await fn(state);
			await this.store.write(state);
		};
		if (this.store.exclusive) await this.store.exclusive(action);
		else await action();
	}
	async init() {
		await this.update(async (state) => {
			if (state.buildQueue?.active) {
				state.buildQueue.active = false;
				state.buildQueue.message =
					"Queue stopped: Build interrupted by restart";
				for (const id of state.buildQueue.nodes) {
					if (["Building", "Copying"].includes(state.buildQueue.states[id]))
						state.buildQueue.states[id] = "Stopped";
					else if (state.buildQueue.states[id] === "Waiting")
						state.buildQueue.states[id] = "Not started";
				}
			}
			if (state.buildJob?.status === "running") {
				await this.interrupt(state.buildJob, state);
				state.buildJob = {
					...state.buildJob,
					status: "error",
					finishedAt: new Date().toISOString(),
					error:
						"Build interrupted by restart. Check the build details and any unfinished template VM before retrying. Existing VMs have been kept.",
				};
			}
		});
	}
	async startQueue(input, context = {}) {
		const nodes = [...new Set(input.nodes || [])];
		if (!nodes.length || nodes.some((id) => typeof id !== "string"))
			throw Error("Select sandbox nodes");
		const queue = {
			id: randomBytes(12).toString("hex"),
			nodes,
			states: Object.fromEntries(nodes.map((id) => [id, "Waiting"])),
			active: true,
			names: input.names || {},
		};
		await this.update((state) => {
			if (state.platformMaintenance)
				throw Error("Updating Umiak… Try the template build again shortly.");
			if (state.buildQueue?.active || state.buildJob?.status === "running")
				throw Error("A template build is already running");
			state.buildQueue = queue;
			if (state.buildJob) state.buildJob.error = null;
		});
		this.queuePending = this.runQueue(queue, input, context);
		return queue;
	}
	async stopQueue() {
		await this.update((s) => {
			if (!s.buildQueue) return;
			s.buildQueue.active = false;
			s.buildQueue.message = "Queue stopped after current build";
			for (const id of s.buildQueue.nodes)
				if (s.buildQueue.states[id] === "Waiting")
					s.buildQueue.states[id] = "Not started";
		});
	}
	async runQueue(queue, input, context) {
		try {
			if (await this.copyExisting(input.slug || "linux", input, context)) {
				await this.update((s) => {
					s.buildQueue.active = false;
					s.buildQueue.message = "Build queue complete";
				});
				return;
			}
		} catch (error) {
			await this.update((s) => {
				s.buildQueue.active = false;
				s.buildQueue.error = error.message;
				s.buildQueue.message = error.message;
			});
			return;
		}
		for (const nodeId of queue.nodes) {
			let proceed = false;
			await this.update((s) => {
				if (s.buildQueue?.id !== queue.id || !s.buildQueue.active) return;
				const ready =
					s.buildQueue.states[nodeId] === "Ready" ||
					s.steps?.templates?.data?.builds?.some(
						(b) =>
							b.nodeId === nodeId && b.templateSlug === (input.slug || "linux"),
					);
				if (ready) {
					s.buildQueue.states[nodeId] = "Ready";
					return;
				}
				s.buildQueue.states[nodeId] = "Building";
				proceed = true;
			});
			if (!proceed) {
				const s = await this.store.read();
				if (s.buildQueue?.active && s.buildQueue.states[nodeId] === "Ready")
					continue;
				return;
			}
			let failure;
			try {
				await this.start(
					input.slug || "linux",
					{ ...input, nodeId },
					{ ...context, queueId: queue.id },
				);
				await this.pending;
				const state = await this.store.read();
				if (state.buildJob.status !== "ready")
					failure = state.buildJob.error || "Build failed";
			} catch (error) {
				failure = error.message;
			}
			await this.update((s) => {
				if (s.buildQueue?.id !== queue.id) return;
				const copy = s.buildJob?.replication;
				const copyFailed = failure && s.buildJob?.manifest && copy?.nodeId;
				s.buildQueue.states[nodeId] = copyFailed
					? "Ready"
					: failure
						? "Failed"
						: "Ready";
				if (copyFailed) s.buildQueue.states[copy.nodeId] = "Copy failed";
				if (failure) {
					s.buildQueue.active = false;
					const phase =
						/(?:during|stage|at)[: ]+(verify|download|install|boot|configure)/i.exec(
							failure,
						)?.[1];
					s.buildQueue.message = `Queue stopped: ${queue.names[nodeId] || nodeId} failed${phase ? ` during ${phase}` : ""}`;
					if (copyFailed)
						s.buildQueue.message = `Linux is ready on ${queue.names[nodeId] || nodeId}. Copy to ${copy.node} failed.`;
					s.buildQueue.error = failure;
					for (const id of queue.nodes)
						if (s.buildQueue.states[id] === "Waiting")
							s.buildQueue.states[id] = "Not started";
				} else if (
					queue.nodes.every((id) => s.buildQueue.states[id] === "Ready")
				) {
					s.buildQueue.active = false;
					s.buildQueue.message = "Build queue complete";
				}
			});
			if (failure) return;
		}
		await this.update((s) => {
			if (s.buildQueue?.id === queue.id && s.buildQueue.active) {
				s.buildQueue.active = false;
				s.buildQueue.message = "Build queue complete";
			}
		});
	}
	async start(slug, input = {}, context = {}) {
		if (!context.queueId) this.queuePending = undefined;
		if (slug === "windows-desktop") slug = "windows";
		if (input.confirmRebuild === "windows-desktop")
			input = { ...input, confirmRebuild: "windows" };
		const state = await this.store.read();
		if (state.buildJob?.status === "running")
			throw new Error("A template build is already running");
		await this.validate(slug, state, input);
		if (input.dryRun === true)
			return { status: "dry-run", slug, templateVmid: input.templateVmid };
		const job = {
			id: randomBytes(12).toString("hex"),
			nodeId: input.nodeId,
			slug,
			status: "running",
			startedAt: new Date().toISOString(),
		};
		await this.update(async (current) => {
			if (current.platformMaintenance)
				throw Error("Updating Umiak… Try the template build again shortly.");
			if (
				(current.buildQueue?.active &&
					current.buildQueue.id !== context.queueId) ||
				current.buildJob?.status === "running"
			)
				throw new Error("A template build is already running");
			await this.reserve(job, state, input);
			current.buildJob = job;
		});
		this.pending = (async () => {
			try {
				let progressWrites = Promise.resolve();
				const onProgress = (chunk) => {
					if (this.logDir)
						progressWrites = progressWrites.then(() =>
							mkdir(this.logDir, { recursive: true, mode: 0o700 })
								.then(() => appendFile(this.logPath(job.id), chunk))
								.catch(() => {}),
						);
					progressWrites = progressWrites.then(() =>
						this.update((current) => {
							if (current.buildJob?.id === job.id)
								current.buildJob.log = (
									(current.buildJob.log || "") + chunk
								).slice(-24000);
						}),
					);
					return progressWrites;
				};
				const manifest = await this.run(
					slug,
					state,
					job,
					input,
					context,
					onProgress,
				);
				await progressWrites;
				await this.update((current) => {
					if (current.buildJob?.id === job.id)
						current.buildJob.manifest = manifest;
				});
				await this.register(manifest, { ...context, job });
				await this.finish(job, state, input, manifest);
				job.registered = true;
				await this.replicate(manifest, { ...context, job });
				await this.update((current) => {
					current.buildJob = {
						...current.buildJob,
						status: "ready",
						finishedAt: new Date().toISOString(),
						manifest,
					};
					current.buildRecords = {
						...current.buildRecords,
						[job.id]: {
							id: job.id,
							slug,
							startedAt: job.startedAt,
							finishedAt: current.buildJob.finishedAt,
							manifest,
						},
					};
				});
			} catch (error) {
				let message = error.message;
				try {
					if (!job.registered) await this.interrupt(job, state);
					if (!job.manifest && !(await this.store.read()).buildJob?.manifest)
						await this.release(job, state);
				} catch (reservationError) {
					message = `${error.message}; reservation: ${reservationError.message}`;
				}
				await this.appendLog(job.id, `\n${message}\n`).catch(() => {});
				await this.update((current) => {
					current.buildJob = {
						...current.buildJob,
						status: "error",
						finishedAt: new Date().toISOString(),
						error: message,
					};
				});
			}
		})();
		return job;
	}
	settled() {
		return this.queuePending || this.pending;
	}
}
