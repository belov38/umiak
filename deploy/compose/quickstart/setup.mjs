import { gatewayCertificates } from "./certificates.mjs";
import { prepareWindowsMedia, validateWindowsMedia } from "./setup-iso.mjs";
// Owner-only setup orchestration. PVE adoption never writes to the host API.

import { execFile } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	buildInvocation,
	runTemplateBuild,
	TemplateBuildJobs,
} from "./setup-build.mjs";
import { renderAdoption, renderPreparation } from "./setup-prep.mjs";

import {
	allocateTemplateVmid,
	templateRange,
	validateTemplateInventory,
	validateTemplateRange,
} from "./setup-vmids.mjs";

const execFileAsync = promisify(execFile);

import {
	atomicSecret,
	checkNode,
	normalizedFingerprint,
	pinnedPve,
	readOptional,
	verifyAdoption,
	verifyIsolation,
} from "./setup-host.mjs";
import { renderHelp, renderSetup } from "./setup-ui.mjs";

export { renderHelp, renderSetup, verifyAdoption };

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
const domain = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
function requireRootCA(pem) {
	try {
		const certificate = new X509Certificate(pem);
		if (!certificate.ca) throw new Error("not a CA");
	} catch {
		throw new Error(
			"A valid PVE root CA certificate is required; supply it in Connect or generate a read-only host report",
		);
	}
	return pem;
}
const STEPS = ["connection", "host", "limits", "network", "templates", "smoke"];
const digest = (value) => createHash("sha256").update(value).digest("hex");
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
			vmidMin >= 500 &&
			vmidMax <= 589 &&
			vmidMin <= vmidMax,
		"Sandbox VMIDs must stay within 500–589",
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
	return { gatewayAddress: host, previewDomain, tunnelUrl, guestDns };
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
				for (const prior of STEPS.slice(0, STEPS.indexOf(name)))
					requireValue(
						state.steps[prior]?.status === "ready",
						`Complete ${prior} first`,
					);
			}
			try {
				const data = await this.steps[name](input, state, context);
				state.steps[name] = {
					status: "ready",
					data,
					updatedAt: new Date().toISOString(),
				};
				if (name === "connection") {
					delete state.hostReport;
					delete state.hostReportAt;
					delete state.preparation;
				}
				for (const next of preserveCompletion
					? []
					: STEPS.slice(STEPS.indexOf(name) + 1))
					if (state.steps[next]) state.steps[next].status = "stale";
				state.complete = STEPS.every(
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
	fetcher = fetch,
} = {}) {
	const connectionOf = (state) => state.steps.connection.data;
	const pveOf = async (state) =>
		makePve(
			connectionOf(state),
			(await readOptional(secretsDir, "pve-token")).trim(),
		);
	const query = (sql, args) => pool.query(sql, args);
	const steps = {
		async connection(input) {
			const connection = validateConnection(input);
			const addresses = [];
			for (const host of [
				new URL(connection.apiUrl).hostname,
				connection.sshHost,
			]) {
				if (isIP(host)) addresses.push(host);
				else
					try {
						for (const item of await lookup(host, { all: true }))
							addresses.push(item.address);
					} catch {}
			}
			connection.deniedAddresses = [...new Set(addresses)].sort();
			const token = (
				input.tokenSecret || (await readOptional(secretsDir, "pve-token"))
			).trim();
			const api = makePve(connection, token);
			await api.get("/version");
			if (token) await atomicSecret(secretsDir, "pve-token", token);
			await atomicSecret(secretsDir, "pve-token-id", connection.tokenId);
			if (input.caPem)
				await atomicSecret(
					secretsDir,
					"pve-root-ca.pem",
					requireRootCA(input.caPem),
				);
			if (input.sshPrivateKey)
				await atomicSecret(
					secretsDir,
					"umiak-node_ed25519",
					input.sshPrivateKey,
				);
			if (input.knownHosts)
				await atomicSecret(secretsDir, "known_hosts", input.knownHosts);
			return connection;
		},
		async host(input, state) {
			requireValue(
				input.mode === "adopt",
				"Run the generated preparation script first, then choose adopt to verify",
			);
			const connection = connectionOf(state);
			const api = await pveOf(state);
			requireValue(
				requireRootCA(await readOptional(secretsDir, "pve-root-ca.pem")),
				"PVE root CA is required before host adoption; supply it in Connect or generate a read-only host report",
			);
			try {
				return await verifyAdoption(api, connection, () =>
					nodeCheck(connection, secretsDir),
				);
			} catch (error) {
				if (
					error.status !== 403 ||
					!state.hostReport ||
					state.hostReportUsed ||
					!Number.isFinite(Date.parse(state.hostReportAt)) ||
					Date.now() - Date.parse(state.hostReportAt) > 5 * 60 * 1000
				)
					throw new Error(
						error.message +
							"; generate a new read-only adoption report, then retry Adopt",
					);
			}
			// Privilege-separated tokens cannot inspect global firewall policy. Accept
			// only a fresh one-time report obtained with the scoped console capability.
			state.hostReportUsed = true;
			const report = state.hostReport;
			verifyIsolation(report.rules, report.ipset, undefined, report.denySets);
			requireValue(
				Number(report.user?.enable ?? 1) === 1 &&
					report.zone?.type === "simple" &&
					report.vnet?.zone === "umiak" &&
					Number(report.firewall?.enable) === 1 &&
					report.vmFirewallsValid === true,
				"Existing host report does not match the required isolated Umiak setup",
			);
			await api.get("/pools/umiak");
			const node = await nodeCheck(connection, secretsDir);
			requireValue(
				node.version &&
					node.config?.vmidMin === 500 &&
					node.config?.vmidMax === 589 &&
					node.config?.vnet === "umiak0",
				"Restricted node-agent configuration mismatch",
			);
			return {
				checks: [
					"user",
					"token",
					"role",
					"pool",
					"SDN zone",
					"SDN VNet",
					"gateway IPSet",
					"egress firewall rules",
					"enabled cluster and sandbox VM firewalls",
					"node host firewall options read (independent of VM isolation)",
					"restricted node-agent",
				].map((name) => ({ name, ok: true })),
				nodeVersion: node.version,
				reportAt: state.hostReportAt,
				ipset: report.ipset,
				rules: report.rules,
				denySets: report.denySets,
			};
		},
		async limits(input, state) {
			const limits = validateLimits({ ...templateRange(state), ...input });
			Object.assign(
				limits,
				validateTemplateInventory(
					limits,
					await (await pveOf(state)).get("/cluster/resources"),
				),
			);
			const connection = connectionOf(state);
			const api = await pveOf(state);
			const storage = await api.get(
				`/nodes/${connection.node}/storage/${limits.storage}/status`,
			);
			requireValue(storage.type === "lvmthin", "Storage must be lvmthin");
			const running = await api.get(`/nodes/${connection.node}/qemu`);
			const used = running
				.filter((x) => x.vmid >= 500 && x.vmid <= 589 && x.status === "running")
				.reduce((sum, x) => sum + Number(x.maxmem || 0) / 1048576, 0);
			requireValue(
				used <= limits.ramCapMb,
				`Running sandbox VMs already reserve ${used} MiB`,
			);
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
			const node = (
				await query(
					`INSERT INTO runtime.nodes(provider_id,name,ram_cap_mb,clone_concurrency,node_agent_ref) VALUES($1,$2,$3,1,$4) ON CONFLICT(provider_id,name) DO UPDATE SET ram_cap_mb=$3,node_agent_ref=$4,clone_concurrency=1,updated_at=now() RETURNING id`,
					[provider, connection.node, limits.ramCapMb, connection.sshHost],
				)
			).rows[0].id;
			const storageId = (
				await query(
					`INSERT INTO runtime.storages(provider_id,node_id,name,driver) VALUES($1,$2,$3,'lvmthin') ON CONFLICT(provider_id,node_id,name) DO UPDATE SET driver='lvmthin' RETURNING id`,
					[provider, node, limits.storage],
				)
			).rows[0].id;
			return { ...limits, providerId: provider, nodeId: node, storageId };
		},
		async network(input, state) {
			const network = validateNetwork(input);
			const report = state.steps.host.data;
			verifyIsolation(
				report.rules,
				report.ipset,
				network.gatewayAddress,
				report.denySets,
			);
			await mkdir(dirname(networkFile), { recursive: true, mode: 0o755 });
			await writeFile(`${networkFile}.new`, JSON.stringify(network), {
				mode: 0o644,
			});
			await rename(`${networkFile}.new`, networkFile);
			return network;
		},
		async templates(input, state) {
			const api = await pveOf(state);
			const connection = connectionOf(state);
			const limits = state.steps.limits.data;
			requireValue(
				Array.isArray(input.builds) &&
					input.builds.some((x) => x.templateSlug === "linux"),
				"Register at least one Linux build",
			);
			const builds = [];
			for (const inputBuild of input.builds) {
				const build = {
					...inputBuild,
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
						build.pveVmid >= 500 &&
						build.pveVmid !== 590 &&
						build.pveVmid !== 599 &&
						build.pveVmid !== 9000 &&
						build.pveVmid !== 9001 &&
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
					`VM ${build.pveVmid} is not a tagged Umiak template`,
				);
				const existing = await query(
					`SELECT id,version,status FROM runtime.template_builds WHERE node_id=$1 AND template_slug=$2 AND pve_vmid=$3 AND status IN ('active','retired') ORDER BY (status='active') DESC`,
					[limits.nodeId, build.templateSlug, build.pveVmid],
				);
				requireValue(
					existing.rows[0]?.status !== "retired",
					"This template build is retired and cannot be adopted for new creates",
				);
				if (existing.rows[0]) {
					builds.push({
						templateSlug: build.templateSlug,
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
				const row = (
					await query(
						`WITH deprecated AS (UPDATE runtime.template_builds SET status='deprecated' WHERE node_id=$5 AND template_slug=$1 AND status='active' RETURNING id) INSERT INTO runtime.template_builds(template_slug,version,os,provider_id,node_id,storage_id,pve_vmid,disk_layout,hw,agent_version,boot_timeout_s,status,promoted_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',now() FROM (SELECT count(*) FROM deprecated) AS previous RETURNING id`,
						[
							build.templateSlug,
							build.version || `adopted-${build.pveVmid}`,
							build.templateSlug.startsWith("windows") ? "windows" : "linux",
							limits.providerId,
							limits.nodeId,
							limits.storageId,
							build.pveVmid,
							JSON.stringify(diskLayout),
							JSON.stringify(hw),
							build.agentVersion || null,
							build.templateSlug.startsWith("windows") ? 1200 : 300,
						],
					)
				).rows[0];
				builds.push({
					templateSlug: build.templateSlug,
					pveVmid: build.pveVmid,
					mediaVerification: build.mediaVerification,
					isoSha256: build.isoSha256,
					virtioSha256: build.virtioSha256,
					id: row.id,
				});
			}
			return { builds };
		},
		async smoke(_input, state, context) {
			const connection = connectionOf(state);
			const pve = await pveOf(state);
			const vms = await pve.get(`/nodes/${connection.node}/qemu`);
			const reserved = vms
				.filter((x) => x.vmid >= 500 && x.vmid <= 589 && x.status === "running")
				.reduce((sum, x) => sum + Number(x.maxmem || 0) / 1048576, 0);
			requireValue(
				reserved + 2048 <= state.steps.limits.data.ramCapMb,
				"Not enough free sandbox RAM for the sequential 2 GiB smoke",
			);
			const call = async (path, options = {}) => {
				const response = await fetcher(apiUrl + path, {
					...options,
					headers: {
						"Content-Type": "application/json",
						"X-Forwarded-For": context.clientIp || "127.0.0.1",
						...options.headers,
					},
				});
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
			const created = await call("/v1/sandboxes", {
				method: "POST",
				headers: { "Idempotency-Key": randomBytes(16).toString("hex") },
				body: JSON.stringify({
					template: "linux",
					size: "2gb",
					labels: { quickstart: "smoke" },
				}),
			});
			const id = created.sandbox?.id || created.id;
			requireValue(id, "Smoke create returned no sandbox ID");
			try {
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
	const jobs = new TemplateBuildJobs({
		store,
		validate: async (slug, state, input) => {
			for (const step of ["connection", "host", "limits", "network"])
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
				(build) => build.templateSlug === slug,
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
					"The node-agent template VMID range does not include the selected slot. Update templateVmidMin/templateVmidMax in /etc/umiak-node.toml to match Setup before building; adoption never rewrites host configuration.",
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
				"Template slot became occupied; retry to allocate a different free VMID.",
			);
			const used = vms
				.filter(
					(vm) => vm.status === "running" && vm.vmid >= 500 && vm.vmid <= 589,
				)
				.reduce((sum, vm) => sum + Number(vm.maxmem || 0) / 1048576, 0);
			requireValue(
				used === 0,
				"Stop running sandbox VMs before a sequential template build",
			);
		},
		run: async (slug, state, job, input, context, onProgress) => {
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
				mediaVerification: prepared.mediaVerification,
				isoSha256: prepared.isoSha256,
				virtioSha256: prepared.virtioSha256,
			};
		},
		register: async (manifest, context) => {
			const state = await store.read();
			const existing = state.steps.templates?.data?.builds || [];
			await wizard.run(
				"templates",
				{
					builds: [
						...existing.filter((x) => x.templateSlug !== manifest.templateSlug),
						manifest,
					],
				},
				{ ...context, dashboardBuild: true },
			);
		},
	});
	const preparationScript = async (prep, connection, token) => {
		const publicKey = (
			await readOptional(secretsDir, "umiak-node_ed25519.pub")
		).trim();
		let nodeSha256;
		try {
			nodeSha256 = digest(
				await readFile(join(assetsDir, "umiak-node-linux-amd64")),
			);
		} catch {}
		if (prep.mode === "fresh")
			requireValue(
				nodeSha256,
				"Node-agent build asset is missing; rebuild the quickstart image before preparing a host",
			);
		const config = {
			origin: prep.origin,
			token,
			publicKey,
			gateway: prep.gateway,
			node: connection.node,
			tokenId: connection.tokenId,
			nodeSha256,
			storage: prep.storage,
			templateVmidMin: prep.templateVmidMin,
			templateVmidMax: prep.templateVmidMax,
			guestDns: prep.guestDns,
			caPath: prep.caPath,
		};
		return prep.mode === "fresh"
			? renderPreparation(config)
			: renderAdoption(config);
	};
	const handler = async (req, res, context) => {
		const path = new URL(req.url, context.origin).pathname;
		if (
			!["/setup", "/app/help", "/help", "/app", "/pve-setup.sh"].includes(
				path,
			) &&
			!path.startsWith("/quickstart/setup/")
		)
			return false;
		if (path === "/pve-setup.sh" || path === "/quickstart/setup/callback") {
			try {
				const input =
					path === "/pve-setup.sh"
						? {
								token: new URL(req.url, context.origin).searchParams.get(
									"token",
								),
								asset: new URL(req.url, context.origin).searchParams.get(
									"asset",
								),
							}
						: await body(req);
				const action = async () => {
					const state = await store.read();
					const prep = state.preparation;
					requireValue(
						prep &&
							prep.expiresAt > Date.now() &&
							typeof input.token === "string" &&
							digest(input.token) === prep.hash,
						"Setup token is invalid, expired or already consumed",
					);
					const connection = connectionOf(state);
					requireValue(
						prep.connectionHash === digest(JSON.stringify(connection)),
						"Connection changed; generate a new setup command",
					);
					if (path === "/pve-setup.sh") {
						requireValue(
							req.method === "GET",
							"Use GET for the preparation script",
						);
						if (input.asset !== null) {
							requireValue(
								input.asset === "node-agent" && prep.mode === "fresh",
								"Unknown or unavailable preparation asset",
							);
							const binary = await readFile(
								join(assetsDir, "umiak-node-linux-amd64"),
							);
							res.writeHead(200, {
								"Content-Type": "application/octet-stream",
								"Content-Length": binary.length,
								"Cache-Control": "no-store",
								"Referrer-Policy": "no-referrer",
							});
							res.end(binary);
							return;
						}
						const script = await preparationScript(
							prep,
							connection,
							input.token,
						);
						res.writeHead(200, {
							"Content-Type": "text/x-shellscript",
							"Cache-Control": "no-store",
							"Referrer-Policy": "no-referrer",
						});
						res.end(script);
						return;
					}
					requireValue(
						req.method === "POST",
						"Use POST for the preparation callback",
					);
					if (prep.mode === "adopt") {
						requireValue(
							input.report?.zone?.type === "simple" &&
								input.report?.vnet?.zone === "umiak",
							"Host verification report is incomplete",
						);
						state.hostReport = input.report;
						state.hostReportAt = new Date().toISOString();
						delete state.hostReportUsed;
						if (
							input.caPem &&
							!(await readOptional(secretsDir, "pve-root-ca.pem"))
						)
							await atomicSecret(
								secretsDir,
								"pve-root-ca.pem",
								requireRootCA(input.caPem),
							);
					} else {
						requireValue(
							typeof input.tokenSecret === "string" &&
								input.tokenSecret.length > 0 &&
								typeof input.caPem === "string" &&
								validateSshPublicKey(input.sshPublicKey),
							"Host callback credentials are incomplete",
						);
						requireValue(
							typeof input.mediaStorage === "string" &&
								NAME.test(input.mediaStorage),
							"Invalid template media storage",
						);
						state.mediaStorage = input.mediaStorage;
						const api = makePve(connection, input.tokenSecret);
						await api.get("/pools/umiak");
						await atomicSecret(secretsDir, "pve-token", input.tokenSecret);
						await atomicSecret(
							secretsDir,
							"pve-root-ca.pem",
							requireRootCA(input.caPem),
						);
						await atomicSecret(
							secretsDir,
							"known_hosts",
							`${connection.sshHost} ${input.sshPublicKey}\n`,
						);
					}
					delete state.preparation;
					await store.write(state);
					json(res, 200, { ok: true });
				};
				if (store.exclusive) await store.exclusive(action);
				else await action();
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
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
		if (path === "/app") {
			const state = await store.read();
			if (!state.complete) {
				res.writeHead(303, { Location: "/setup" });
				res.end();
				return true;
			}
			return false;
		}
		if (req.method === "GET" && (path === "/app/help" || path === "/help")) {
			res.writeHead(303, { Location: "/app/getting-started" });
			res.end();
			return true;
		}
		if (req.method === "GET" && path === "/setup") {
			const state = await store.read();
			state.detectedTemplates = [];
			if (state.steps.connection?.status === "ready") {
				try {
					const api = await pveOf(state);
					const vms = await api.get(`/nodes/${connectionOf(state).node}/qemu`);
					for (const vm of vms) {
						if (
							Number(vm.template) !== 1 ||
							vm.vmid < 500 ||
							vm.vmid === 590 ||
							vm.vmid === 599 ||
							vm.vmid === 9000 ||
							vm.vmid === 9001 ||
							!String(vm.tags || "")
								.split(";")
								.includes("umiak-tpl")
						)
							continue;
						const config = await api.get(
							`/nodes/${connectionOf(state).node}/qemu/${vm.vmid}/config`,
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
						const retired = await query(
							"SELECT id FROM runtime.template_builds WHERE node_id=$1 AND pve_vmid=$2 AND status='retired'",
							[state.steps.limits?.data?.nodeId, Number(vm.vmid)],
						);
						if (retired.rows.length) continue;
						state.detectedTemplates.push({
							templateSlug: slug,
							pveVmid: Number(vm.vmid),
							name: vm.name,
						});
					}
				} catch (error) {
					state.templateDetectionError = error.message;
				}
			}
			html(res, renderSetup(state, context.origin));
			return true;
		}
		if (req.method === "GET" && path === "/quickstart/setup/media/storages") {
			try {
				const state = await store.read();
				const api = await pveOf(state);
				const items = await api.get(
					`/nodes/${connectionOf(state).node}/storage`,
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
		if (req.method === "GET" && path === "/quickstart/setup/build") {
			const state = await store.read();
			json(res, 200, {
				buildJob: state.buildJob || null,
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
		if (req.method === "POST" && path === "/quickstart/setup/build") {
			try {
				const input = await body(req);
				json(res, 202, await jobs.start(input.slug || "linux", input, context));
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "POST" && path === "/quickstart/setup/prepare") {
			try {
				const input = await body(req);
				const state = await store.read();
				requireValue(
					state.steps.connection?.status === "ready",
					"Connect Proxmox first",
				);
				const storage =
					input.storage ?? state.steps.limits?.data?.storage ?? "local-lvm";
				requireValue(
					typeof storage === "string" && NAME.test(storage),
					"Invalid storage name",
				);
				const mode = input.mode === "fresh" ? "fresh" : "adopt";
				const token = randomBytes(32).toString("hex");
				if (
					mode === "fresh" &&
					!(await readOptional(secretsDir, "umiak-node_ed25519"))
				) {
					await atomicSecret(secretsDir, "key-init", "");
					await execFileAsync("ssh-keygen", [
						"-q",
						"-t",
						"ed25519",
						"-N",
						"",
						"-C",
						"umiak-quickstart",
						"-f",
						join(secretsDir, "umiak-node_ed25519"),
					]);
				}
				const gateway =
					input.gatewayAddress ||
					state.steps.network?.data?.gatewayAddress ||
					"";
				if (mode === "fresh")
					requireValue(
						/^\d{1,3}(?:\.\d{1,3}){3}$/.test(gateway),
						"Fresh preparation requires the gateway LAN IPv4 address",
					);
				const preparationRange = validateTemplateRange({
					vmidMin: 500,
					vmidMax: 589,
					...templateRange(state),
					...(input.templateVmidMin !== undefined
						? { templateVmidMin: Number(input.templateVmidMin) }
						: {}),
					...(input.templateVmidMax !== undefined
						? { templateVmidMax: Number(input.templateVmidMax) }
						: {}),
				});
				state.preparation = {
					...preparationRange,
					caPath: "/etc/ssl/certs/ca-certificates.crt",
					mode,
					storage,
					guestDns:
						input.guestDns || state.steps.network?.data?.guestDns || "1.1.1.1",
					connectionHash: digest(JSON.stringify(state.steps.connection.data)),
					hash: digest(token),
					expiresAt: Date.now() + 15 * 60 * 1000,
					origin: context.origin,
					gateway,
				};
				const url = `${context.origin}/pve-setup.sh?token=${token}`;
				const script = await preparationScript(
					state.preparation,
					connectionOf(state),
					token,
				);
				const sha256 = digest(script);
				await store.write(state);
				const host = new URL(context.origin).hostname;
				const insecure =
					context.origin.startsWith("http:") &&
					!["localhost", "127.0.0.1", "[::1]"].includes(host);
				const warning = insecure
					? "WARNING: HTTP delivers a script executed as root and sends the PVE API token secret, CA and host key back without encryption. Use Tailscale Serve or HTTPS for preparation. The SHA256 below only pins the displayed script; HTTP cannot authenticate this page or protect the callback."
					: undefined;
				json(res, 200, {
					warning,
					sha256,
					command: `# SHA256: ${sha256}\ncurl -fsSL '${url}' -o pve-setup.sh\nprintf '%s  %s\\n' '${sha256}' 'pve-setup.sh' | sha256sum -c - && bash pve-setup.sh --dry-run\n# Inspect pve-setup.sh, then execute:\nprintf '%s  %s\\n' '${sha256}' 'pve-setup.sh' | sha256sum -c - && bash pve-setup.sh`,
					expiresIn: 900,
				});
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		if (req.method === "POST" && path.startsWith("/quickstart/setup/")) {
			try {
				const step = path.slice("/quickstart/setup/".length);
				json(res, 200, await wizard.run(step, await body(req), context));
			} catch (error) {
				json(res, 400, { error: error.message });
			}
			return true;
		}
		json(res, 405, { error: "method_not_allowed" });
		return true;
	};
	handler.init = async () => {
		await store.init?.();
		await jobs.init();
	};
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
