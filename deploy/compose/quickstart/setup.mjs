import { canonicalFetch } from "../canonical-fetch.mjs";
import { platformReleaseChannel } from "../release-channel.mjs";
import { gatewayCertificates } from "./certificates.mjs";
import { rollbackRecipe } from "./recipe-rollback.mjs";
import { recipeRollout } from "./recipe-rollout.mjs";
import { cleanupBuild } from "./setup-build-cleanup.mjs";
import { windowsDesktop } from "./setup-desktop.mjs";
import { prepareWindowsMedia, validateWindowsMedia } from "./setup-iso.mjs";
import { nodeService } from "./setup-nodes.mjs";
import { replicateActiveTemplates } from "./template-replication.mjs";
// Owner-only setup orchestration. PVE adoption never writes to the host API.

import { randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	buildInvocation,
	runTemplateBuild,
	TemplateBuildJobs,
} from "./setup-build.mjs";
import {
	checkNode,
	normalizedFingerprint,
	pinnedPve,
	readOptional,
	verifyAdoption,
	verifyIsolation,
} from "./setup-host.mjs";
import { renderHelp, renderSetup } from "./setup-ui.mjs";
import {
	allocateTemplateVmid,
	templateRange,
	validateTemplateInventory,
	validateTemplateRange,
} from "./setup-vmids.mjs";

export { renderHelp, renderSetup, verifyAdoption };

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
const domain = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
export function requireRootCA(pem) {
	try {
		const certificate = new X509Certificate(pem);
		if (!certificate.ca) throw new Error("not a CA");
	} catch {
		throw new Error(
			"A valid PVE root CA certificate is required; re-run the installer on the PVE node to refresh the connection",
		);
	}
	return pem;
}
// Browser-driven steps, in order. `connection` and `host` are internal records
// written only by the installer import; they gate every step below.
const STEPS = ["limits", "network", "templates", "smoke"];
const BOOTSTRAP = ["connection", "host"];
function requireValue(ok, message) {
	if (!ok) throw new Error(message);
}
export function validateSshPublicKey(value) {
	requireValue(
		typeof value === "string" &&
			!/[\r\n]/.test(value) &&
			/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(value),
		"Invalid SSH host public key",
	);
	const key = Buffer.from(value.split(" ")[1], "base64");
	requireValue(
		key.length === 51 &&
			key.readUInt32BE(0) === 11 &&
			key.subarray(4, 15).toString() === "ssh-ed25519" &&
			key.readUInt32BE(15) === 32,
		"Invalid SSH host public key",
	);
	return value;
}
export function validateConnection(input) {
	const url = new URL(input.apiUrl);
	requireValue(
		url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/",
		"PVE URL must be an https origin",
	);
	requireValue(NAME.test(input.node), "Invalid node name");
	requireValue(
		/^[a-zA-Z0-9._-]+@pve![a-zA-Z0-9._-]+$/.test(input.tokenId),
		"Use an existing @pve API token ID",
	);
	requireValue(
		/^[a-f0-9]{64}$/.test(normalizedFingerprint(input.fingerprint)),
		"TLS SHA256 fingerprint is required",
	);
	const sshHost = input.sshHost || url.hostname;
	requireValue(
		/^[a-zA-Z0-9.:-]+$/.test(sshHost) && !sshHost.startsWith("-"),
		"Invalid SSH host",
	);
	return {
		apiUrl: url.origin,
		node: input.node,
		tokenId: input.tokenId,
		fingerprint: normalizedFingerprint(input.fingerprint),
		tlsName: input.tlsName || url.hostname,
		sshHost,
	};
}
export function validateLimits(input) {
	const { storage, vmidMin, vmidMax, ramCapMb } = input;
	requireValue(NAME.test(storage), "Invalid storage name");
	requireValue(
		Number.isInteger(vmidMin) &&
			Number.isInteger(vmidMax) &&
			vmidMin >= 100 &&
			vmidMax <= 999999999 &&
			vmidMin <= vmidMax,
		"Invalid sandbox VMID range",
	);
	requireValue(
		Number.isInteger(ramCapMb) && ramCapMb >= 2048 && ramCapMb <= 8192,
		"Sandbox RAM cap must be 2048–8192 MiB",
	);
	return {
		storage,
		vmidMin,
		vmidMax,
		ramCapMb,
		...validateTemplateRange({
			...input,
			templateVmidMin: input.templateVmidMin ?? 600,
			templateVmidMax: input.templateVmidMax ?? 699,
		}),
	};
}
export function validateNetwork(input) {
	const host = input.gatewayAddress;
	requireValue(
		typeof host === "string" &&
			domain.test(host) &&
			host !== "localhost" &&
			!/^127\./.test(host) &&
			host !== "0.0.0.0",
		"Use the gateway LAN address reachable from guests",
	);
	const guestDns = input.guestDns || "1.1.1.1";
	requireValue(
		isIP(guestDns) !== 0,
		"Guest DNS resolver must be an IP address",
	);
	const previewDomain =
		input.previewDomain || `umiak.${host.replaceAll(".", "-")}.sslip.io`;
	requireValue(
		domain.test(previewDomain) && !previewDomain.includes(".."),
		"Invalid preview domain",
	);
	const tunnelUrl =
		input.tunnelUrl ||
		`wss://${/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? `tunnel.${host.replaceAll(".", "-")}.sslip.io` : host}/v1/connect`;
	const url = new URL(tunnelUrl);
	requireValue(
		url.protocol === "wss:" && !url.username && !url.password,
		"Tunnel URL must use wss",
	);
	const guestSubnet = input.guestSubnet || "10.88.0.0/24";
	const [address, prefixText] = guestSubnet.split("/");
	const prefix = Number(prefixText);
	const octets = address.split(".").map(Number);
	const ip = octets.reduce((n, v) => n * 256 + v, 0);
	const block = 2 ** (32 - prefix);
	const privateIp =
		octets[0] === 10 ||
		(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
		(octets[0] === 192 && octets[1] === 168);
	requireValue(
		guestSubnet === `${address}/${prefix}` &&
			isIP(address) === 4 &&
			Number.isInteger(prefix) &&
			prefix >= 18 &&
			prefix <= 24 &&
			ip % block === 0 &&
			privateIp,
		"Invalid private guest /18 to /24",
	);

	return {
		gatewayAddress: host,
		previewDomain,
		tunnelUrl,
		guestDns,
		guestSubnet,
	};
}
export class PgSetupStore {
	constructor(pool) {
		this.pool = pool;
	}
	async init() {
		await this.pool.query("CREATE SCHEMA IF NOT EXISTS quickstart");
		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS quickstart.setup (id boolean PRIMARY KEY DEFAULT true CHECK(id),state jsonb NOT NULL DEFAULT '{"steps":{},"complete":false}')`,
		);
		await this.pool.query(
			"INSERT INTO quickstart.setup(id) VALUES(true) ON CONFLICT DO NOTHING",
		);
	}
	async read() {
		return (
			await this.pool.query("SELECT state FROM quickstart.setup WHERE id=true")
		).rows[0].state;
	}
	async write(state) {
		await this.pool.query(
			"UPDATE quickstart.setup SET state=$1 WHERE id=true",
			[JSON.stringify(state)],
		);
	}
	async exclusive(fn) {
		const client = await this.pool.connect();
		try {
			await client.query(
				"SELECT pg_advisory_lock(hashtextextended('umiak-quickstart:setup',0))",
			);
			return await fn();
		} finally {
			await client.query(
				"SELECT pg_advisory_unlock(hashtextextended('umiak-quickstart:setup',0))",
			);
			client.release();
		}
	}
}
export class SetupWizard {
	constructor({ store, steps }) {
		this.store = store;
		this.steps = steps;
		this.queue = Promise.resolve();
	}
	run(name, input, context = {}) {
		const action = async () => {
			const state = await this.store.read();
			state.steps ??= {};
			const preserveCompletion =
				state.complete === true &&
				name === "templates" &&
				context.dashboardBuild === true;
			state.complete = preserveCompletion;
			if (!Object.hasOwn(this.steps, name))
				throw new Error("Unknown setup step");
			if (STEPS.includes(name)) {
				for (const prior of [
					...BOOTSTRAP,
					...STEPS.slice(0, STEPS.indexOf(name)),
				])
					requireValue(
						state.steps[prior]?.status === "ready",
						BOOTSTRAP.includes(prior)
							? `The installer has not recorded ${prior} yet; re-run it on the PVE node`
							: `Complete ${prior} first`,
					);
			}
			try {
				const previous = state.steps[name];
				const data = await this.steps[name](
					input,
					state,
					name === "smoke"
						? {
								...context,
								onSmokeProgress: async (stage) => {
									state.smokeProgress = stage;
									try {
										await this.store.write(state);
									} catch {}
								},
							}
						: context,
				);
				// Inventory changes after a build are observations, not settings changes.
				const settings = (value) =>
					name === "limits" && value
						? Object.fromEntries(
								Object.entries(value).filter(
									([key]) =>
										!["occupiedTemplateVmids", "freeTemplateVmids"].includes(
											key,
										),
								),
							)
						: value;
				const unchanged =
					["limits", "network"].includes(name) &&
					previous?.status === "ready" &&
					isDeepStrictEqual(settings(previous.data), settings(data));
				state.steps[name] = {
					status: "ready",
					data,
					updatedAt: new Date().toISOString(),
				};
				for (const next of preserveCompletion || unchanged
					? []
					: STEPS.slice(STEPS.indexOf(name) + 1))
					if (state.steps[next]) state.steps[next].status = "stale";
				state.complete = [...BOOTSTRAP, ...STEPS].every(
					(step) => state.steps[step]?.status === "ready",
				);
				await this.store.write(state);
				return state;
			} catch (error) {
				if (preserveCompletion) throw error;
				state.steps[name] = {
					status: "error",
					error: error.message,
					updatedAt: new Date().toISOString(),
				};
				await this.store.write(state);
				throw error;
			}
		};
		const work = () =>
			this.store.exclusive ? this.store.exclusive(action) : action();
		const result = this.queue.then(work, work);
		this.queue = result.catch(() => {});
		return result;
	}
}

async function body(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		requireValue(raw.length <= 262144, "Request too large");
	}
	return JSON.parse(raw || "{}");
}
function json(res, status, value) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(value));
}
function html(res, value) {
	res.writeHead(200, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
	});
	res.end(value);
}

// Owner-mode API accepts only the public API authority as Host. Connect to the
// fixed internal DNS name but present that authority (same as apps/mcp).
export function publicApiFetch(
	publicApiUrl = process.env.UMIAK_API_URL,
	transport = canonicalFetch,
) {
	if (!publicApiUrl) return fetch;
	const host = new URL(publicApiUrl).host;
	return async (input, init) => {
		const request = new Request(input, init);
		request.headers.set("host", host);
		return transport(request);
	};
}

export function createSetupHandler({
	pool,
	store = new PgSetupStore(pool),
	secretsDir = process.env.UMIAK_PVE_SECRETS_DIR || "/pve-secrets",
	networkFile = process.env.UMIAK_QUICKSTART_NETWORK_FILE ||
		join(secretsDir, "quickstart-network.json"),
	assetsDir = process.env.UMIAK_QUICKSTART_ASSETS || "/app/quickstart-assets",
	apiUrl = "http://api:8080",
	makePve = pinnedPve,
	nodeCheck = checkNode,
	fetcher = publicApiFetch(),
	nodes = nodeService(pool),
} = {}) {
	const connectionOf = (state) => state.steps.connection.data;
	const pveOf = async (state) =>
		makePve(
			connectionOf(state),
			(await readOptional(secretsDir, "pve-token")).trim(),
		);
	const query = (sql, args) => pool.query(sql, args);
	const steps = {
		async limits(input, state, context = {}) {
			const limits = validateLimits({ ...templateRange(state), ...input });
			Object.assign(
				limits,
				validateTemplateInventory(
					limits,
					await (await pveOf(state)).get("/cluster/resources"),
				),
			);
			const connection = connectionOf(state);
			const retiredBootstrap =
				context.bootstrap === true && (await nodes.installerNodeRetired(state));
			if (!retiredBootstrap) {
				const api = await pveOf(state);
				const storage = await api.get(
					`/nodes/${connection.node}/storage/${limits.storage}/status`,
				);
				requireValue(storage.type === "lvmthin", "Storage must be lvmthin");
				const running = await api.get(`/nodes/${connection.node}/qemu`);
				const used = running
					.filter(
						(x) =>
							x.vmid >= limits.vmidMin &&
							x.vmid <= limits.vmidMax &&
							x.status === "running",
					)
					.reduce((sum, x) => sum + Number(x.maxmem || 0) / 1048576, 0);
				requireValue(
					used <= limits.ramCapMb,
					`Running sandbox VMs already reserve ${used} MiB`,
				);
			}
			const provider = (
				await query(
					`INSERT INTO runtime.providers(kind,name,cluster_mac_id,vmid_min,vmid_max,api_url,tls_name,secret_ref) VALUES('proxmox',$1,1,$2,$3,$4,$5,'pve') ON CONFLICT(name) DO UPDATE SET vmid_min=$2,vmid_max=$3,api_url=$4,tls_name=$5,updated_at=now() RETURNING id`,
					[
						connection.node,
						limits.vmidMin,
						limits.vmidMax,
						connection.apiUrl,
						connection.tlsName,
					],
				)
			).rows[0].id;
			const registered = await nodes.register(
				{
					providerId: provider,
					name: connection.node,
					sshHost: connection.sshHost,
					ramCapMb: limits.ramCapMb,
					storage: limits.storage,
					mediaStorage: input.mediaStorage || state.mediaStorage || "local",
				},
				{ preserveState: context.bootstrap === true },
			);
			const node = registered.nodeId;
			const storageId = registered.storageId;
			return { ...limits, providerId: provider, nodeId: node, storageId };
		},
		async network(input, state, context = {}) {
			const network = validateNetwork({
				...input,
				guestSubnet: context.bootstrap
					? input.guestSubnet
					: state.bootstrap?.facts?.network?.guestSubnet ||
						state.steps.network?.data?.guestSubnet ||
						input.guestSubnet,
			});
			const report = state.steps.host.data;
			verifyIsolation(
				report.rules,
				report.ipset,
				network.gatewayAddress,
				report.denySets,
			);
			// Canonical form; the installer writes the same bytes before first start.
			const content = JSON.stringify(network);
			if (
				(await readOptional(dirname(networkFile), basename(networkFile))) !==
				content
			) {
				await mkdir(dirname(networkFile), { recursive: true, mode: 0o755 });
				await writeFile(`${networkFile}.new`, content, { mode: 0o644 });
				await rename(`${networkFile}.new`, networkFile);
			}
			return network;
		},
		async templates(input, state, context = {}) {
			const api = await pveOf(state);
			requireValue(
				Array.isArray(input.builds) &&
					[
						...input.builds,
						...(state.steps.templates?.data?.builds || []),
					].some((x) => x.templateSlug === "linux"),
				"Register at least one Linux build",
			);
			const builds = [];
			for (const inputBuild of input.builds) {
				const selected = await nodes.select(state, inputBuild.nodeId);
				const connection = connectionOf(selected);
				const limits = selected.steps.limits.data;
				const build = {
					...inputBuild,
					nodeId: limits.nodeId,
					templateSlug:
						inputBuild.templateSlug === "windows-desktop"
							? "windows"
							: inputBuild.templateSlug,
				};
				requireValue(
					["linux", "linux-desktop", "windows"].includes(build.templateSlug),
					"Unknown template",
				);
				requireValue(
					Number.isInteger(build.pveVmid) &&
						build.pveVmid >= 100 &&
						!(
							build.pveVmid >= limits.vmidMin && build.pveVmid <= limits.vmidMax
						),
					"Existing template VMID is protected or overlaps the sandbox range",
				);
				const config = await api.get(
					`/nodes/${connection.node}/qemu/${build.pveVmid}/config`,
				);
				requireValue(
					Number(config.template) === 1 &&
						String(config.tags || "")
							.split(";")
							.includes("umiak-tpl"),
					`VM ${build.pveVmid} is not recognized as a Umiak template`,
				);
				// PVE always reports ostype for our templates; absent means unknown.
				requireValue(
					!config.ostype ||
						(build.templateSlug === "windows") ===
							String(config.ostype).startsWith("win"),
					`VM ${build.pveVmid} OS does not match template ${build.templateSlug}`,
				);
				if (build.templateSlug === "windows")
					requireValue(
						await windowsDesktop(
							config,
							connection.node,
							build.pveVmid,
							join(secretsDir, "template-registry"),
						),
						"This legacy headless Windows build has no verified desktop marker and cannot be adopted",
					);
				// A physically retired VMID may hold a different, newly verified artifact.
				// Only an internal build job may distinguish it by version; manual adoption
				// must still refuse retired history at this VMID.
				const artifactVersion = context.job ? build.version : null;
				requireValue(
					!context.job ||
						(typeof artifactVersion === "string" && artifactVersion.length > 0),
					"Verified build version is required",
				);
				const existing = await query(
					`SELECT id,version,status,(template_slug='windows' AND headless IS DISTINCT FROM false) AS headless FROM runtime.template_builds WHERE node_id=$1 AND template_slug=$2 AND pve_vmid=$3 AND ($4::text IS NULL OR version=$4) AND (status IN ('active','retired') OR (template_slug='windows' AND headless IS DISTINCT FROM false)) ORDER BY (status='active') DESC,created_at DESC`,
					[limits.nodeId, build.templateSlug, build.pveVmid, artifactVersion],
				);
				requireValue(
					existing.rows[0]?.status !== "retired",
					"This template build is retired and cannot be adopted for new creates",
				);
				requireValue(
					!existing.rows[0]?.headless,
					"This headless Windows build cannot be adopted for new creates",
				);
				if (existing.rows[0]) {
					builds.push({
						templateSlug: build.templateSlug,
						nodeId: limits.nodeId,
						node: connection.node,
						pveVmid: build.pveVmid,
						mediaVerification: build.mediaVerification,
						isoSha256: build.isoSha256,
						virtioSha256: build.virtioSha256,
						id: existing.rows[0].id,
					});
					continue;
				}
				const diskLayout = {};
				for (const [key, value] of Object.entries(config)) {
					if (
						/^(scsi|sata|virtio|ide|efidisk|tpmstate)\d+$/.test(key) &&
						!String(value).includes("media=cdrom")
					) {
						const parts = String(value).split(",");
						const disk = {};
						const volume = parts.shift();
						const match = volume.match(/-(\d+)$/);
						if (match) disk.index = match[1];
						for (const part of parts) {
							const [k, v] = part.split("=");
							disk[k] = v;
						}
						diskLayout[key] = disk;
					}
				}
				requireValue(
					Object.keys(diskLayout).length > 0,
					"Template has no disk layout",
				);
				const hw = { cloudinit: false };
				for (const key of [
					"machine",
					"cpu",
					"bios",
					"ostype",
					"scsihw",
					"agent",
					"serial0",
					"vga",
					"tablet",
					"localtime",
					"rng0",
				])
					if (config[key] !== undefined) hw[key] = config[key];
				const row = await nodes.registerTemplate(
					{
						templateSlug: build.templateSlug,
						version: build.version || `adopted-${build.pveVmid}`,
						os: build.templateSlug.startsWith("windows") ? "windows" : "linux",
						providerId: limits.providerId,
						nodeId: limits.nodeId,
						storageId: limits.storageId,
						pveVmid: build.pveVmid,
						diskLayout,
						hw,
						agentVersion: build.agentVersion || null,
						bootTimeoutS: build.templateSlug.startsWith("windows") ? 1200 : 300,
					},
					context.job?.id,
				);

				builds.push({
					templateSlug: build.templateSlug,
					nodeId: limits.nodeId,
					node: connection.node,
					pveVmid: build.pveVmid,
					mediaVerification: build.mediaVerification,
					isoSha256: build.isoSha256,
					virtioSha256: build.virtioSha256,
					id: row.id,
				});
			}
			const keys = new Set(builds.map((b) => `${b.nodeId}:${b.templateSlug}`));
			return {
				builds: [
					...(state.steps.templates?.data?.builds || []).filter(
						(b) =>
							!keys.has(
								`${b.nodeId || state.steps.limits.data.nodeId}:${b.templateSlug}`,
							),
					),
					...builds,
				],
			};
		},
		async smoke(input, state, context) {
			if (input.nodeId) state = await nodes.select(state, input.nodeId);
			const connection = connectionOf(state);
			const pve = await pveOf(state);
			const vms = await pve.get(`/nodes/${connection.node}/qemu`);
			const reserved = vms
				.filter(
					(x) =>
						x.vmid >= state.steps.limits.data.vmidMin &&
						x.vmid <= state.steps.limits.data.vmidMax &&
						x.status === "running",
				)
				.reduce((sum, x) => sum + Number(x.maxmem || 0) / 1048576, 0);
			requireValue(
				reserved + 2048 <= state.steps.limits.data.ramCapMb,
				"Not enough free sandbox RAM for the sequential 2 GiB smoke",
			);
			const call = async (path, options = {}) => {
				const response = await fetcher(
					(path === "/v1/setup/smoke" ? "http://api:8081" : apiUrl) + path,
					{
						...options,
						headers: {
							"Content-Type": "application/json",
							"X-Forwarded-For": context.clientIp || "127.0.0.1",
							...(path === "/v1/setup/smoke" ? { Origin: context.origin } : {}),
							...options.headers,
						},
					},
				);
				const text = await response.text();
				let data;
				try {
					data = JSON.parse(text);
				} catch {
					data = {};
				}
				if (response.status === 404 && options.allowNotFound)
					return { state: "deleted" };
				if (!response.ok)
					throw new Error(
						`Smoke ${path}: HTTP ${response.status} ${data.error?.code || ""}`,
					);
				return data;
			};
			await context.onSmokeProgress?.("Creating");
			const created = await call(
				input.nodeId ? "/v1/setup/smoke" : "/v1/sandboxes",
				{
					method: "POST",
					headers: { "Idempotency-Key": randomBytes(16).toString("hex") },
					body: JSON.stringify(
						input.nodeId
							? { nodeId: input.nodeId }
							: {
									template: "linux",
									size: "2gb",
									labels: { quickstart: "smoke" },
								},
					),
				},
			);
			const id = created.sandbox?.id || created.id;
			requireValue(id, "Smoke create returned no sandbox ID");
			try {
				await context.onSmokeProgress?.("Starting");
				const deadline = Date.now() + 300000;
				let ready = false;
				while (Date.now() < deadline) {
					const result = await call(`/v1/sandboxes/${id}`);
					const sandbox = result.sandbox || result;
					if (sandbox.state === "ready") {
						ready = true;
						break;
					}
					if (sandbox.state === "error")
						throw new Error("Smoke sandbox failed to boot");
					await new Promise((resolve) => setTimeout(resolve, 1500));
				}
				requireValue(ready, "Smoke sandbox boot timed out");
				await context.onSmokeProgress?.("Running command");
				const exec = await call(`/v1/sandboxes/${id}/commands`, {
					method: "POST",
					body: JSON.stringify({
						command: "printf umiak-quickstart-ok",
						mode: "sync",
					}),
				});
				requireValue(
					exec.command?.exitCode === 0 && exec.stdout === "umiak-quickstart-ok",
					"Smoke exec did not produce the expected output",
				);
				return { sandboxId: id, exec: "passed", deleted: true };
			} finally {
				await context.onSmokeProgress?.("Cleaning up");
				await call(`/v1/sandboxes/${id}`, {
					method: "DELETE",
					headers: { "Umiak-Confirm-Delete": id },
				});
				const deadline = Date.now() + 120000;
				let deleted = false;
				while (Date.now() < deadline) {
					const result = await call(`/v1/sandboxes/${id}`, {
						allowNotFound: true,
					});
					if ((result.sandbox || result).state === "deleted") {
						deleted = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
				requireValue(
					deleted,
					"Smoke deletion is still pending; inspect the sandbox in the dashboard before retrying",
				);
			}
		},
	};
	const wizard = new SetupWizard({ store, steps });
	const recoverBuild = async (state, request) => {
		const inventory = await nodes.list(state.steps.limits.data.providerId);
		const node = inventory.find((n) => n.nodeId === request.nodeId);
		if (!node || node.buildJobId !== request.jobId)
			throw Error("Unknown unfinished node build");
		return cleanupBuild({
			service: nodes,
			node,
			request,
			state,
			limits: state.steps.limits.data,
			api: () => pveOf(state),
			probe: nodeCheck,
			secretsDir,
		});
	};
	const jobs = new TemplateBuildJobs({
		store,
		logDir: join(secretsDir, "template-build-logs"),
		validate: async (slug, state, input) => {
			const channel = state.recipeChannel;
			const available =
				channel?.following === platformReleaseChannel(state) && !channel?.error
					? channel?.available
					: null;
			input.recipeDirectory = available?.directory;
			input.recipeVersion = available?.version;
			state = await nodes.select(state, input.nodeId);
			input.nodeId = state.steps.limits.data.nodeId;
			if (input.mediaStorage && input.mediaStorage !== state.mediaStorage)
				throw Error("Use the selected node configured media storage");
			input.mediaStorage = state.mediaStorage;
			for (const step of [...BOOTSTRAP, "limits", "network"])
				requireValue(
					state.steps[step]?.status === "ready",
					`Complete ${step} before building`,
				);
			if (slug.startsWith("windows")) {
				await validateWindowsMedia(input);
				if (input.isoUrl)
					input.iso = input.isoSha256
						? `windows-${input.isoSha256.toLowerCase()}.iso`
						: decodeURIComponent(
								new URL(input.isoUrl).pathname.split("/").pop(),
							);
				input.mediaVerification =
					input.isoSha256 && (!input.virtioUrl || input.virtioSha256)
						? "verified"
						: "unverified";
			}
			const api = await pveOf(state);
			const existing = state.steps.templates?.data?.builds?.find(
				(build) =>
					build.templateSlug === slug &&
					(build.nodeId || state.steps.limits.data.nodeId) === input.nodeId,
			);
			requireValue(
				!existing || input.confirmRebuild === slug,
				"Explicitly confirm rebuilding this template by its name",
			);
			input.templateVmid = await allocateTemplateVmid(api, {
				...state.steps.limits.data,
				...templateRange(state),
			});
			if (!input.dryRun) {
				const node = await nodeCheck(connectionOf(state), secretsDir);
				requireValue(
					input.templateVmid >= node.config?.templateVmidMin &&
						input.templateVmid <= node.config?.templateVmidMax,
					"The node-agent template VMID range does not include the selected VMID. Update templateVmidMin/templateVmidMax in /etc/umiak-node.toml to match Setup before building; adoption never rewrites host configuration.",
				);
			}
			const invocation = buildInvocation(
				slug,
				state,
				secretsDir,
				"https://build.invalid",
				assetsDir,
				"validate",
				{ ...input, isoSha256: input.isoSha256 || "0".repeat(64) },
			);
			const vms = await api.get(
				`/nodes/${state.steps.connection.data.node}/qemu`,
			);
			requireValue(
				!vms.some((vm) => Number(vm.vmid) === invocation.slot),
				"The selected VMID is now in use. Retry to allocate a different free VMID.",
			);
			const used = vms
				.filter(
					(vm) =>
						vm.status === "running" &&
						vm.vmid >= state.steps.limits.data.vmidMin &&
						vm.vmid <= state.steps.limits.data.vmidMax,
				)
				.reduce((sum, vm) => sum + Number(vm.maxmem || 0) / 1048576, 0);
			requireValue(
				used === 0,
				"Stop running sandbox VMs before a sequential template build",
			);
		},
		reserve: (job) => nodes.reserve(job),
		interrupt: (job, state) => nodes.interrupt(job, state),
		release: (job, state) =>
			recoverBuild(state, { nodeId: job.nodeId, jobId: job.id }),
		finish: async (job, state) => {
			const selected = await nodes.select(state, job.nodeId);
			const vms = await (await pveOf(state)).get(
				`/nodes/${connectionOf(selected).node}/qemu`,
			);
			requireValue(
				!vms.some(
					(vm) =>
						vm.vmid >= selected.steps.limits.data.vmidMin &&
						vm.vmid <= selected.steps.limits.data.vmidMax &&
						vm.status !== "stopped",
				),
				"Build verification VMs are not confirmed stopped; reservation retained",
			);
			await nodes.finish(job);
		},
		run: async (slug, state, job, input, context, onProgress) => {
			state = await nodes.select(state, job.nodeId);
			const vms = await (await pveOf(state)).get(
				`/nodes/${connectionOf(state).node}/qemu`,
			);
			requireValue(
				!vms.some(
					(vm) =>
						vm.vmid >= state.steps.limits.data.vmidMin &&
						vm.vmid <= state.steps.limits.data.vmidMax &&
						vm.status !== "stopped",
				),
				"Stop sandbox VMs before a template build",
			);
			let prepared = input;
			if (slug.startsWith("windows"))
				prepared = await prepareWindowsMedia(
					await pveOf(state),
					connectionOf(state).node,
					input,
					{
						progress: onProgress,
						checksum: async (name, storage) =>
							(
								await nodeCheck(connectionOf(state), secretsDir, {
									op: "media.sha256",
									args: { name, ...(storage !== "local" ? { storage } : {}) },
								})
							).sha256,
					},
				);
			const existingVersions = (
				await query("SELECT template_slug,version FROM runtime.template_builds")
			).rows;
			const manifest = await runTemplateBuild(
				buildInvocation(
					slug,
					state,
					secretsDir,
					context.origin,
					assetsDir,
					job.id,
					prepared,
				),
				{ secretsDir, assetsDir, onProgress, existingVersions },
			);
			return {
				...manifest,
				recipeVersion: input.recipeVersion,
				iso: prepared.iso,
				virtioIso: prepared.virtioIso,
				mediaVerification: prepared.mediaVerification,
				isoSha256: prepared.isoSha256,
				virtioSha256: prepared.virtioSha256,
			};
		},
		register: async (manifest, context) => {
			await wizard.run(
				"templates",
				{ builds: [{ ...manifest, nodeId: context.job.nodeId }] },
				{ ...context, dashboardBuild: true },
			);
			const source = (
				await query(
					"SELECT id FROM runtime.template_builds WHERE node_id=$1 AND pve_vmid=$2 AND status='active'",
					[context.job.nodeId, manifest.pveVmid],
				)
			).rows[0];
			if (source) {
				await query(
					"UPDATE runtime.template_builds SET manifest=$2 WHERE id=$1",
					[source.id, JSON.stringify(manifest)],
				);
				const current = await store.read();
				await replicateActiveTemplates({
					pool,
					state: current,
					sourceBuildId: source.id,
					api: await pveOf(current),
					nodeCheck,
					secretsDir,
					onProgress: async (progress) => {
						await jobs.update((state) => {
							if (state.buildJob?.id === context.job.id)
								state.buildJob.replication = progress;
							if (
								state.buildQueue?.active &&
								state.buildQueue.nodes.includes(progress.nodeId)
							)
								state.buildQueue.states[progress.nodeId] =
									progress.phase === "ready" ? "Ready" : "Copying";
						});
					},
				});
			}
		},
	});
	const channel = recipeRollout({
		jobs,
		store,
		nodes,
		query,
		pool,
		pveOf,
		connectionOf,
		nodeCheck,
		secretsDir,
	});
	const handler = async (req, res, context) => {
		const path = new URL(req.url, context.origin).pathname;
		if (
			!["/setup", "/app/help", "/help", "/app"].includes(path) &&
			!path.startsWith("/quickstart/setup/")
		)
			return false;
		if (!context.owner) {
			json(res, 401, { error: "owner_required" });
			return true;
		}
		if (path === "/quickstart/setup/certificates" && req.method === "GET") {
			try {
				json(
					res,
					200,
					await gatewayCertificates(
						process.env.UMIAK_GATEWAY_SECRETS_DIR || "/gateway-secrets",
					),
				);
			} catch {
				json(res, 503, { error: "Cannot read guest gateway certificates" });
			}
			return true;
		}
		if (path === "/app") return false;

		if (req.method === "GET" && (path === "/app/help" || path === "/help")) {
			res.writeHead(303, { Location: "/app/getting-started" });
			res.end();
			return true;
		}
		if (req.method === "GET" && path === "/setup") {
			const state = await store.read();
			state.sandboxNodes = await nodes.list(
				state.steps.limits?.data?.providerId,
				state,
			);
			state.buildRecovery = {};
			for (const node of state.sandboxNodes) {
				if (!node.buildJobId || state.buildJob?.status === "running") continue;
				try {
					state.buildRecovery[node.nodeId] = await recoverBuild(state, {
						nodeId: node.nodeId,
						jobId: node.buildJobId,
						inspect: true,
					});
				} catch (error) {
					state.buildRecovery[node.nodeId] = { error: error.message };
				}
			}
			state.detectedTemplates = [];
			if (state.steps.connection?.status === "ready") {
				for (const target of state.sandboxNodes) {
					if (target.state !== "active") continue;
					try {
						const scoped = await nodes.select(state, target.nodeId);
						const api = await pveOf(state);
						const vms = await api.get(
							`/nodes/${connectionOf(scoped).node}/qemu`,
						);
						for (const vm of vms) {
							if (
								Number(vm.template) !== 1 ||
								vm.vmid < 100 ||
								!String(vm.tags || "")
									.split(";")
									.includes("umiak-tpl")
							)
								continue;
							const config = await api.get(
								`/nodes/${connectionOf(scoped).node}/qemu/${vm.vmid}/config`,
							);
							let slug =
								String(config.tags || "")
									.split(";")
									.map((tag) => tag.replace(/^umiak-template-/, ""))
									.find((tag) =>
										[
											"linux",
											"linux-desktop",
											"windows",
											"windows-desktop",
										].includes(tag),
									) ||
								(String(vm.name || "").includes("windows-desktop")
									? "windows-desktop"
									: String(vm.name || "").includes("windows")
										? "windows"
										: String(vm.name || "").includes("desktop")
											? "linux-desktop"
											: "linux");
							if (slug === "windows-desktop") slug = "windows";
							if (
								slug === "windows" &&
								!(await windowsDesktop(
									config,
									connectionOf(scoped).node,
									vm.vmid,
									join(secretsDir, "template-registry"),
								))
							)
								continue;
							const registered = await query(
								"SELECT status,(template_slug='windows' AND headless IS DISTINCT FROM false) AS headless FROM runtime.template_builds WHERE node_id=$1 AND pve_vmid=$2 ORDER BY (status='active') DESC,created_at DESC LIMIT 1",
								[scoped.steps.limits.data.nodeId, Number(vm.vmid)],
							);
							if (
								registered.rows[0]?.status === "retired" ||
								registered.rows[0]?.headless
							)
								continue;
							state.detectedTemplates.push({
								nodeId: target.nodeId,
								node: target.name,
								templateSlug: slug,
								pveVmid: Number(vm.vmid),
								name: vm.name,
							});
						}
					} catch (error) {
						state.templateDetectionError = error.message;
					}
				}
			}
			html(res, renderSetup(state));
			return true;
		}
		if (req.method === "GET" && path === "/quickstart/setup/media/storages") {
			try {
				const state = await store.read();
				const api = await pveOf(state);
				const items = await api.get(
					`/nodes/${connectionOf(await nodes.select(state, new URL(req.url, context.origin).searchParams.get("nodeId"))).node}/storage`,
				);
				json(res, 200, {
					storages: items.filter((x) =>
						String(x.content || "")
							.split(",")
							.includes("iso"),
					),
				});
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "GET" && path === "/quickstart/setup/state") {
			json(res, 200, await store.read());
			return true;
		}
		if (path === "/quickstart/setup/recipes") {
			try {
				if (req.method === "POST") {
					const input = await body(req);
					if (input.rollback) {
						const build = (
							await query(
								"SELECT * FROM runtime.template_builds WHERE id=$1 AND status='deprecated'",
								[input.rollback],
							)
						).rows[0];
						await rollbackRecipe({
							build,
							nodes,
							state: await store.read(),
							pveOf,
							connectionOf,
							nodeCheck,
							secretsDir,
						});
						await channel.settings({ auto: false });
					} else {
						await channel.settings(input);
						if (input.retry) {
							await channel.update((c) => {
								c.error = null;
							});
							void channel.tick(true);
						}
					}
				} else if (req.method !== "GET") throw Error("Unsupported method");
				const state = await store.read();
				const builds = (
					await query(
						"SELECT id,template_slug,node_id,version,status,manifest->>'recipeVersion' AS recipe_version FROM runtime.template_builds WHERE status IN ('active','deprecated') ORDER BY created_at DESC",
					)
				).rows;
				json(res, 200, {
					channel: state.recipeChannel || {
						enabled: true,
						auto: true,
						intervalHours: 24,
					},
					builds,
				});
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}

		if (req.method === "GET" && path === "/quickstart/setup/build/log") {
			const state = await store.read();
			const file = jobs.logPath(
				new URL(req.url, context.origin).searchParams.get("jobId") ||
					state.buildJob?.id,
			);
			let text = state.buildJob?.log || "";
			if (file)
				try {
					text = await readFile(file, "utf8");
				} catch {}
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
			});
			res.end(text || "No build output yet.\n");
			return true;
		}
		if (req.method === "GET" && path === "/quickstart/setup/build") {
			const state = await store.read();
			json(res, 200, {
				buildJob: state.buildJob || null,
				buildQueue: state.buildQueue || null,
				builds: state.steps.templates?.data?.builds || [],
			});
			return true;
		}
		if (
			req.method === "POST" &&
			[
				"/quickstart/setup/media/validate",
				"/quickstart/setup/validate-media",
			].includes(path)
		) {
			try {
				const input = await body(req);
				await validateWindowsMedia(input);
				json(res, 200, {
					ok: true,
					mediaVerification:
						input.isoSha256 && (!input.virtioUrl || input.virtioSha256)
							? "verified"
							: "unverified",
					message:
						!input.isoSha256 || (input.virtioUrl && !input.virtioSha256)
							? "Not verified: the ISO will be used as downloaded"
							: "ISO inputs are valid; no download or build was started",
				});
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "POST" && path === "/quickstart/setup/build/recover") {
			let input;
			try {
				input = await body(req);
				const state = await store.read();
				if (state.buildJob?.status === "running" || state.buildQueue?.active)
					throw Error("Wait for the current build to finish");
				const result = await recoverBuild(state, input);
				if (input.retry && !input.inspect)
					await jobs.start("linux", { nodeId: input.nodeId }, context);
				json(res, 200, result);
			} catch (error) {
				await jobs
					.appendLog(input?.jobId, `\nRecovery: ${error.message}\n`)
					.catch(() => {});
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "POST" && path === "/quickstart/setup/build/stop") {
			await jobs.stopQueue();
			json(res, 200, { ok: true });
			return true;
		}
		if (req.method === "POST" && path === "/quickstart/setup/build") {
			try {
				const input = await body(req);
				if (input.nodes) {
					const inventory = await nodes.list(
						(await store.read()).steps.limits.data.providerId,
					);
					if (
						!Array.isArray(input.nodes) ||
						input.nodes.some(
							(id) =>
								!inventory.some((n) => n.nodeId === id && n.state === "active"),
						)
					)
						throw Error("Unknown sandbox node");
					input.names = Object.fromEntries(
						inventory.map((n) => [n.nodeId, n.name]),
					);
					json(res, 202, await jobs.startQueue(input, context));
				} else
					json(
						res,
						202,
						await jobs.start(input.slug || "linux", input, context),
					);
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "POST" && path.startsWith("/quickstart/setup/")) {
			const step = path.slice("/quickstart/setup/".length);
			// Connection and host facts come from the installer, never from the browser.
			if (!Object.hasOwn(steps, step)) {
				json(res, 404, { error: "not_found" });
				return true;
			}
			try {
				json(res, 200, await wizard.run(step, await body(req), context));
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		json(res, path.startsWith("/quickstart/setup/") ? 405 : 404, {
			error: path.startsWith("/quickstart/setup/")
				? "method_not_allowed"
				: "not_found",
		});
		return true;
	};
	handler.init = async () => {
		await store.init?.();
		await jobs.init();
		// Retry incomplete copies after restart without ever launching another build.
		const retryCopies = async () => {
			const current = await store.read();
			if (!current.steps?.limits?.data?.providerId) return;
			const ready = (
				await query(
					"SELECT to_regclass('runtime.volume_transfers') IS NOT NULL AS ready",
				)
			).rows[0]?.ready;
			if (ready !== true) return;
			const pending = (
				await query(
					"SELECT DISTINCT source_id FROM runtime.volume_transfers WHERE kind='template' AND phase<>'done'",
				)
			).rows;
			if (current.buildJob?.manifest) {
				const b = (
					await query(
						"SELECT id FROM runtime.template_builds WHERE node_id=$1 AND pve_vmid=$2 AND status='active'",
						[current.buildJob.nodeId, current.buildJob.manifest.pveVmid],
					)
				).rows[0];
				if (b && !pending.some((p) => p.source_id === b.id))
					pending.push({ source_id: b.id });
			}
			for (const p of pending)
				await replicateActiveTemplates({
					pool,
					state: current,
					sourceBuildId: p.source_id,
					api: await pveOf(current),
					nodeCheck,
					secretsDir,
					onProgress: async (progress) =>
						jobs.update((s) => {
							if (s.buildJob) s.buildJob.replication = progress;
						}),
				});

			const job = current.buildJob;
			if (job?.manifest && job.status === "error") {
				const found = (
					await query(
						"SELECT id FROM runtime.template_builds WHERE node_id=$1 AND pve_vmid=$2 AND status='active'",
						[job.nodeId, job.manifest.pveVmid],
					)
				).rowCount;
				if (found) {
					await jobs.finish(job, current);
					await jobs.update((s) => {
						if (s.buildJob?.id === job.id) {
							s.buildJob.status = "ready";
							s.buildJob.error = null;
							s.buildJob.finishedAt = new Date().toISOString();
						}
					});
				}
			}
		};
		let copying = false;
		const sweep = () => {
			if (copying || jobs.pending === null) return;
			copying = true;
			retryCopies()
				.catch(() => {})
				.finally(() => {
					copying = false;
				});
		};
		const timer = setInterval(sweep, 30000);
		timer.unref();
		const recipeTimer = setInterval(() => void channel.tick(), 60000);
		recipeTimer.unref();
		void channel.tick();
		handler.close = () => {
			clearInterval(timer);
			clearInterval(recipeTimer);
		};
		sweep();
	};
	handler.nodes = nodes;
	handler.wizard = wizard;
	handler.jobs = jobs;
	handler.deniedPeer = async (address) => {
		const normalized = address?.replace(/^::ffff:/, "");
		const state = await store.read();
		const connection = state.steps.connection?.data;
		if (!connection) return false;
		const addresses = connection.deniedAddresses || [
			new URL(connection.apiUrl).hostname,
			connection.sshHost,
		];
		return addresses.includes(normalized);
	};
	return handler;
}
