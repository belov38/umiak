// E2E backend (S8 plan decision 10): the real api and worker code in one
// process, on Payload, with fakes where the stack has no Proxmox, gateway
// or guest:
//   - api: buildDeps + startApi as in production, but the agent is the
//     in-process FakeAgent of `apps/api/src/testing` (commands are real
//     processes of this container, files live in temp directories);
//   - worker: createWorker over the fake PVE world of
//     `apps/worker/test/fakes` (FakeInfra per node of the bootstrapped
//     topology, FakeAgentWorld boots the "VM": tunnel session + agent
//     `pool_ready`), a fake gateway, and the real ctl-idp-sync against
//     Keycloak;
//   - a control listener (SBX_E2E_CONTROL_PORT, default 9099; compose
//     publishes it on 127.0.0.1 only) for the Playwright run.
// Test-only: lives under apps/web/e2e, never in a production image or code
// path. Imports are relative (the image installs the api and worker
// dependencies only; their packages resolve from their own node_modules).
import { readFileSync } from "node:fs";
import http from "node:http";
import { decodeUuid } from "../../../../packages/auth/src/index.ts";
import type { SecretFile } from "../../../../packages/core/src/index.ts";
import {
	KeyRing,
	PgBossJobSender,
} from "../../../../packages/core/src/index.ts";
import { createPool } from "../../../../packages/db/src/index.ts";
import {
	KeycloakAdminClient,
	KeycloakIdpSync,
} from "../../../../packages/payload/src/index.ts";
import { createApiLogger } from "../../../api/src/http/logger.ts";
import { resolveCommandRef } from "../../../api/src/map/command.ts";
import { buildDeps, startApi } from "../../../api/src/server.ts";
import { loadSettings } from "../../../api/src/settings.ts";
import { FakeAgent as ApiFakeAgent } from "../../../api/src/testing/fake-agent.ts";
import { createLogger } from "../../../worker/src/context.ts";
import { runIdpSync } from "../../../worker/src/controllers/idp-sync.ts";
import { PromMetrics } from "../../../worker/src/metrics.ts";
import { openWorkerPayload } from "../../../worker/src/payload.ts";
import type { ClaimRequest } from "../../../worker/src/ports.ts";
import { createWorker, type Worker } from "../../../worker/src/worker.ts";
import { FakeAgent as WorkerFakeAgent } from "../../../worker/test/fakes/agent.ts";
import { FakeGateway } from "../../../worker/test/fakes/gateway.ts";
import {
	FakeInfra,
	FakeInfraRegistry,
} from "../../../worker/test/fakes/infra.ts";
import {
	FakeAgentWorld,
	TEST_TIMING,
} from "../../../worker/test/fakes/world.ts";

const CONTROL_PORT = Number(process.env.SBX_E2E_CONTROL_PORT ?? 9099);
const WORKER_HTTP_PORT = Number(process.env.SBX_E2E_WORKER_HTTP_PORT ?? 9095);

function required(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`${name} is not set`);
	return v;
}

/**
 * The api's fake guest. A PTY command of the fake is a process on pipes,
 * without a terminal; the one thing of a tty line discipline the dashboard
 * depends on is ICRNL (xterm sends Enter as CR, a shell reading a pipe
 * waits for LF), so CR becomes LF on PTY input. `ptySizes` (resize) stays
 * the fake's.
 */
class E2eGuest extends ApiFakeAgent {
	readonly #ptys = new Set<string>();

	override async start(
		...args: Parameters<ApiFakeAgent["start"]>
	): ReturnType<ApiFakeAgent["start"]> {
		const [, req] = args;
		if (req.spec.pty !== undefined) this.#ptys.add(req.commandId);
		return super.start(...args);
	}

	override async sendInput(
		...args: Parameters<ApiFakeAgent["sendInput"]>
	): ReturnType<ApiFakeAgent["sendInput"]> {
		const [machineId, req] = args;
		if (!this.#ptys.has(req.commandId)) return super.sendInput(...args);
		const data = Buffer.from(req.data);
		for (let i = 0; i < data.length; i++) if (data[i] === 0x0d) data[i] = 0x0a;
		return super.sendInput(machineId, { ...req, data });
	}
}

/**
 * The worker's agent port (claim, env, secrets, activity) recording like
 * the worker tests' fake, and handing env and secrets to the api's fake
 * guest, so commands started through the api see them.
 */
class BridgeAgent extends WorkerFakeAgent {
	readonly #guest: E2eGuest;

	constructor(guest: E2eGuest) {
		super();
		this.#guest = guest;
	}

	override async claim(
		machineId: string,
		req: ClaimRequest,
		requestId: string,
	): Promise<void> {
		await super.claim(machineId, req, requestId);
		const m = this.#guest.machine(machineId);
		m.env = { ...req.env };
		m.secretEnv = { ...req.secretEnv };
	}

	override async updateEnv(
		machineId: string,
		env: Record<string, string>,
		requestId: string,
	): Promise<void> {
		await super.updateEnv(machineId, env, requestId);
		this.#guest.machine(machineId).env = { ...env };
	}

	override async updateSecrets(
		machineId: string,
		secrets: { secretEnv: Record<string, string>; secretFiles: SecretFile[] },
		requestId: string,
	): Promise<void> {
		await super.updateSecrets(machineId, secrets, requestId);
		const m = this.#guest.machine(machineId);
		m.secretEnv = { ...secrets.secretEnv };
	}
}

/** Keycloak for ctl-idp-sync, switchable to an empty realm (abort scenario). */
class SwitchableKeycloak {
	empty = false;
	readonly #real: KeycloakAdminClient;

	constructor(real: KeycloakAdminClient) {
		this.#real = real;
	}

	listUsers(): ReturnType<KeycloakAdminClient["listUsers"]> {
		return this.empty ? Promise.resolve([]) : this.#real.listUsers();
	}

	userExists(id: string): Promise<boolean> {
		return this.empty ? Promise.resolve(false) : this.#real.userExists(id);
	}
}

async function main(): Promise<void> {
	const settings = loadSettings(process.env);
	const log = createApiLogger({ level: settings.logLevel });
	const wlog = createLogger({ level: settings.logLevel, name: "e2e-worker" });

	// --- api: production deps, fake agent
	const guest = new E2eGuest();
	const built = await buildDeps(settings, log);
	const deps = { ...built.deps, agent: guest };
	const api = await startApi(settings, deps);

	// --- worker: fake PVE world over the bootstrapped topology
	const pool = createPool(settings.databaseUrl, 20, {
		onError: (err) => wlog.error({ err: err.message }, "worker pool error"),
	});
	const wp = await openWorkerPayload({
		databaseUrl: settings.databaseUrl,
		secret: settings.payloadSecret,
		log: wlog,
	});
	let worker: Worker | undefined;
	const jobs = {
		send: ((...args) => {
			if (worker === undefined) throw new Error("worker not started");
			return new PgBossJobSender(worker.boss).send(...args);
		}) as PgBossJobSender["send"],
	};
	const world = new FakeAgentWorld({ pool, jobs });
	const registry = new FakeInfraRegistry();
	const nodes = await pool.query<{
		node_id: string;
		provider_id: string;
		cluster_mac_id: number;
		vmid_min: number;
		vmid_max: number;
	}>(
		`SELECT n.id AS node_id, p.id AS provider_id, p.cluster_mac_id, p.vmid_min, p.vmid_max
		   FROM runtime.nodes n JOIN runtime.providers p ON p.id = n.provider_id`,
	);
	// Fake VMs cost nothing: room for every sandbox of repeated runs on a
	// reused stack (the topology of config/sbx.yaml caps the node at 8 GB,
	// four 2 GB sandboxes).
	await pool.query(
		"UPDATE runtime.nodes SET ram_cap_mb = GREATEST(ram_cap_mb, 1048576)",
	);
	for (const n of nodes.rows) {
		const builds = await pool.query<{ pve_vmid: number }>(
			"SELECT DISTINCT pve_vmid FROM runtime.template_builds WHERE node_id = $1",
			[n.node_id],
		);
		registry.set(
			n.node_id,
			new FakeInfra({
				pool,
				providerId: n.provider_id,
				clusterMacId: n.cluster_mac_id,
				vmidRange: { min: n.vmid_min, max: n.vmid_max },
				templateVmids: builds.rows.map((b) => b.pve_vmid),
				lifecycle: world,
			}),
		);
	}
	if (nodes.rows.length === 0) {
		throw new Error(
			"no topology: run the migrate service (sbx-admin bootstrap)",
		);
	}

	const kcSecret = readFileSync(
		required("SBX_IDP_SYNC_CLIENT_SECRET_FILE"),
		"utf8",
	).trim();
	const keycloak = new SwitchableKeycloak(
		new KeycloakAdminClient({
			baseUrl: required("SBX_IDP_SYNC_KEYCLOAK_URL"),
			realm: process.env.SBX_IDP_SYNC_REALM ?? "sbx",
			clientId: process.env.SBX_IDP_SYNC_CLIENT_ID ?? "sbx-worker",
			clientSecret: kcSecret,
		}),
	);
	const idpSync = new KeycloakIdpSync({
		payload: wp.payload,
		keycloak,
		log: wlog,
	});
	const metrics = new PromMetrics({ log: wlog });
	worker = createWorker({
		pool,
		config: wp.config,
		keys: KeyRing.fromFile(settings.dataKeysFile),
		infra: registry,
		agent: new BridgeAgent(guest),
		gateway: new FakeGateway(),
		log: wlog,
		metrics,
		timing: TEST_TIMING,
		reconcileDryRun: true,
		migrateOnStart: false,
		httpPort: WORKER_HTTP_PORT,
		pollingIntervalSeconds: 0.5,
		idpSync,
		// Passes run on demand (POST /idp-sync); the timer would race them.
		idpSyncIntervalMs: 24 * 3600 * 1000,
		payloadReady: () => wp.ready(),
	});
	world.ctx = worker.ctx;
	await worker.start();

	const serviceTokens = JSON.parse(
		readFileSync(settings.serviceTokensFile, "utf8"),
	) as { gateway?: string[] };
	const gatewayToken = serviceTokens.gateway?.[0];

	// --- control listener
	const control = http.createServer((req, res) => {
		const reply = (status: number, body: unknown) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};
		const url = new URL(req.url ?? "/", "http://control");
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = () =>
				chunks.length === 0
					? {}
					: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
							string,
							unknown
						>);
			(async () => {
				if (req.method === "GET" && url.pathname === "/healthz") {
					return reply(200, { ok: true });
				}
				if (req.method === "POST" && url.pathname === "/idp-sync") {
					// One pass, like the controller (metrics, log), plus the result.
					let result: unknown = null;
					const once = {
						run: async () => {
							result = await idpSync.run();
							return result as Awaited<ReturnType<KeycloakIdpSync["run"]>>;
						},
					};
					await runIdpSync(worker.ctx, once);
					const text = await metrics.registry.metrics();
					const gauge = /^sbx_idp_sync_aborted (\d+)$/m.exec(text)?.[1];
					return reply(200, { result, abortedGauge: Number(gauge) });
				}
				if (req.method === "PUT" && url.pathname === "/keycloak") {
					const mode = body().mode;
					if (mode !== "empty" && mode !== "real") {
						return reply(400, { error: "mode: empty | real" });
					}
					keycloak.empty = mode === "empty";
					return reply(200, { mode });
				}
				if (req.method === "GET" && url.pathname.startsWith("/route/")) {
					const label = url.pathname.slice("/route/".length);
					const r = await fetch(
						`http://127.0.0.1:${api.ports.internal}/internal/v1/gateway/routes/${encodeURIComponent(label)}`,
						{ headers: { authorization: `Bearer ${gatewayToken ?? ""}` } },
					);
					return reply(r.status, await r.json());
				}
				if (req.method === "POST" && url.pathname === "/payload-users") {
					// Users that never signed in through the browser, bound to
					// Keycloak accounts (the abort scenario needs > 5 of them).
					const users = body().users as { email: string; sub: string }[];
					for (const u of users) {
						await wp.payload.create({
							collection: "users",
							data: { email: u.email, idpSubject: u.sub, active: true },
							overrideAccess: true,
							depth: 0,
						});
					}
					return reply(200, { created: users.length });
				}
				if (req.method === "GET" && url.pathname.startsWith("/pty-sizes/")) {
					// Sizes a PTY command got: its spec's, then every resize.
					const id = resolveCommandRef(
						url.pathname.slice("/pty-sizes/".length),
					);
					return reply(200, { sizes: guest.ptySizes(id) });
				}
				if (req.method === "GET" && url.pathname.startsWith("/machine/")) {
					// What the fake guest of a machine got (env from the worker).
					// A sandbox id (sb_…): its current machine.
					const sb = decodeUuid(
						"sandbox",
						url.pathname.slice("/machine/".length),
					);
					const row = await pool.query<{ machine_id: string | null }>(
						"SELECT machine_id FROM runtime.sandboxes WHERE id = $1",
						[sb],
					);
					const id = row.rows[0]?.machine_id;
					if (id == null) return reply(404, { error: "no machine" });
					const m = guest.machine(id);
					return reply(200, {
						env: m.env,
						secretEnvNames: Object.keys(m.secretEnv),
					});
				}
				reply(404, { error: "not found" });
			})().catch((err: unknown) => {
				log.error(
					{ err: err instanceof Error ? err.message : String(err) },
					"e2e control failed",
				);
				if (!res.headersSent) {
					reply(500, {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			});
		});
	});
	await new Promise<void>((r) => control.listen(CONTROL_PORT, "0.0.0.0", r));
	log.info(
		{ control: CONTROL_PORT, worker: WORKER_HTTP_PORT },
		"e2e backend ready",
	);

	let stopping = false;
	const stop = async () => {
		if (stopping) process.exit(1);
		stopping = true;
		control.close();
		await worker?.stop({ graceful: false }).catch(() => {});
		await api.close().catch(() => {});
		await built.dispose().catch(() => {});
		await wp.close().catch(() => {});
		await pool.end().catch(() => {});
		await guest.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
}

await main();
