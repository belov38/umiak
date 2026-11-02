// Serial, durable S5 build jobs. Never retire or rebuild an occupied template slot.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SLOTS = {
	linux: 597,
	"linux-desktop": 596,
	windows: 598,
	"windows-desktop": 595,
};
export function buildInvocation(
	slug,
	state,
	secretsDir,
	origin,
	assetsDir,
	jobId = "build",
	input = {},
) {
	const slot = SLOTS[slug];
	if (!slot) throw new Error("Unknown template recipe");
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
		UMIAK_TEMPLATE_VMID: "599",
		UMIAK_CLUSTER_ID: "1",
		UMIAK_PVE_STORAGE: limits.storage,
		UMIAK_PVE_VNET: "umiak0",
		UMIAK_PVE_POOL: "umiak",
		UMIAK_STATE_DB: join(directory, "state.db"),
		UMIAK_TEMPLATE_REGISTRY: join(directory, "registry"),
		UMIAK_IMAGE_CACHE: join(secretsDir, "image-cache"),
		UMIAK_TEMPLATE_LOG_DIR: join(directory, "logs"),
		UMIAK_UPDATE_KEYS_FILE: join(
			secretsDir,
			"update-signing",
			"update-keys.pub",
		),
	};
	const args = [
		"apps/template-builder/src/main.ts",
		"build",
		slug,
		"--node",
		connection.node,
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
			!/^\/[^\0]+\.iso$/i.test(input.iso || "") ||
			!/^[a-fA-F0-9]{64}$/.test(input.isoSha256 || "")
		)
			throw new Error(
				"Windows needs an absolute ISO path mounted into the stack and its SHA256",
			);
		args.push("--iso", input.iso, "--iso-sha256", input.isoSha256);
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
	{ secretsDir, assetsDir, launch = spawn } = {},
) {
	await mkdir(invocation.directory, { recursive: true, mode: 0o700 });
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
			tail = (tail + String(chunk)).slice(-12000);
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
	const registry = invocation.env.UMIAK_TEMPLATE_REGISTRY;
	for (const file of await readdir(registry)) {
		if (!file.endsWith(".json")) continue;
		const manifest = JSON.parse(await readFile(join(registry, file), "utf8"));
		if (
			manifest.templateSlug === invocation.slug &&
			manifest.status === "ready" &&
			manifest.verify?.ok
		)
			return manifest;
	}
	throw new Error("Template builder did not produce a verified ready manifest");
}
export class TemplateBuildJobs {
	constructor({
		store,
		run,
		validate = async () => {},
		register = async () => {},
	}) {
		this.store = store;
		this.run = run;
		this.validate = validate;
		this.register = register;
		this.pending = Promise.resolve();
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
		await this.update((state) => {
			if (state.buildJob?.status === "running")
				state.buildJob = {
					...state.buildJob,
					status: "error",
					error:
						"Build interrupted by restart. Inspect its S5 registry and outstanding build VM before retrying; no broad cleanup is performed.",
				};
		});
	}
	async start(slug, input = {}, context = {}) {
		const state = await this.store.read();
		if (state.buildJob?.status === "running")
			throw new Error("A template build is already running");
		await this.validate(slug, state, input);
		const job = {
			id: randomBytes(12).toString("hex"),
			slug,
			status: "running",
			startedAt: new Date().toISOString(),
		};
		await this.update((current) => {
			if (current.buildJob?.status === "running")
				throw new Error("A template build is already running");
			current.buildJob = job;
			current.complete = false;
		});
		this.pending = (async () => {
			try {
				const manifest = await this.run(slug, state, job, input, context);
				await this.register(manifest, context);
				await this.update((current) => {
					current.buildJob = {
						...job,
						status: "ready",
						finishedAt: new Date().toISOString(),
						manifest,
					};
				});
			} catch (error) {
				await this.update((current) => {
					current.buildJob = {
						...job,
						status: "error",
						finishedAt: new Date().toISOString(),
						error: error.message,
					};
				});
			}
		})();
		return job;
	}
	settled() {
		return this.pending;
	}
}
