// Opt-in live check of the forced Windows fork (S9 §24.8) on the host `pve`:
// the real worker operations (create, fork with forceStop, stop, the fork
// target's create, delete) over the real Proxmox adapter, with the agent
// reached through QGA (`sbx-agent call` over the guest agent instead of the
// tunnel; no gateway or tunnel is needed). Skipped unless
// SBX_PVE_FORCE_STOP=1:
//
//   SBX_PVE_FORCE_STOP=1 pnpm --filter @sbx/worker exec vitest run test/pve-force-stop.test.ts
//
// Host rules: VMIDs 580-589 only, one 4 GB Windows VM at a time (the source
// is stopped before the fork boots, a `qm list` check before each start),
// template 598 is cloned only.
// Everything made is deleted at the end.
//
// Env: SBX_PVE_URL (default https://100.64.10.2:8006), SBX_PVE_TLS_NAME
// (pve), SBX_NODE_SSH_HOST (100.64.10.2), SBX_SECRETS_DIR (~/.config/sbx),
// SBX_FORCE_STOP_TEMPLATE (598).
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	create,
	type DescMessage,
	type DescMethodUnary,
	fromJson,
	type JsonValue,
	toJson,
} from "@bufbuild/protobuf";
import {
	Code,
	ConnectError,
	type Transport,
	type UnaryResponse,
} from "@connectrpc/connect";
import type { AgentClient } from "@sbx/agent-client";
import { ingestAgentEvents, isSbxError } from "@sbx/core";
import { createTestDatabase, type TestDatabase } from "@sbx/db/testing";
import { Qga } from "@sbx/pve";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectAgentPort } from "../src/adapters/agent-connect.ts";
import {
	PveInfraRegistry,
	pveClientsFromSecrets,
} from "../src/adapters/pve-infra.ts";
import { handleMachineEvents } from "../src/handlers/machine-events.ts";
import type { NodeInfra } from "../src/ports.ts";
import { createWorld, type TestWorld } from "./fakes/world.ts";
import {
	createSandbox,
	forkSandbox,
	type OpsEnv,
	opsEnv,
	row,
	run,
	runSnapshotJobs,
	snapshotsOf,
} from "./helpers/ops.ts";

const LIVE = process.env.SBX_PVE_FORCE_STOP === "1";
const SECRETS_DIR =
	process.env.SBX_SECRETS_DIR ?? join(homedir(), ".config", "sbx");
const SSH_HOST = process.env.SBX_NODE_SSH_HOST ?? "100.64.10.2";
const PVE_URL = process.env.SBX_PVE_URL ?? "https://100.64.10.2:8006";
const TLS_NAME = process.env.SBX_PVE_TLS_NAME ?? "pve";
const TEMPLATE_VMID = Number(process.env.SBX_FORCE_STOP_TEMPLATE ?? 598);
const VMIDS = { min: 580, max: 589 };
const WIN_MB = 4096;
/** Sandbox VMs (500-599) running at once, other threads included. */
const HOST_SANDBOX_RAM_MB = 8192;
const STEP_TIMEOUT = 30 * 60_000;
const AGENT_EXE = "C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe";
const MARKER_PATH = "C:\\sbx-force-stop.txt";

const log = (s: string) =>
	process.stderr.write(
		`[pve-force-stop ${new Date().toISOString().slice(11, 23)}] ${s}\n`,
	);

const uuidHex = (s: string) => s.replace(/-/g, "").toLowerCase();

/** `qm list` on the host: MB of running sandbox VMs (500-599). */
function hostSandboxRamMb(): { mb: number; running: string[] } {
	const out = execFileSync(
		"ssh",
		["-o", "BatchMode=yes", "pve", "qm", "list"],
		{
			encoding: "utf8",
		},
	);
	let mb = 0;
	const running: string[] = [];
	for (const line of out.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		const vmid = Number(f[0]);
		const status = f.at(-4);
		const mem = Number(f.at(-3));
		if (vmid >= 500 && vmid <= 599 && status === "running") {
			mb += mem;
			running.push(`${vmid}:${mem}`);
		}
	}
	return { mb, running };
}

/** Waits until one more 4 GB VM fits in the host's sandbox budget. */
async function roomForWindows(): Promise<void> {
	const end = Date.now() + 20 * 60_000;
	for (;;) {
		const h = hostSandboxRamMb();
		if (h.mb + WIN_MB <= HOST_SANDBOX_RAM_MB) {
			log(`host sandbox RAM ${h.mb} MB running (${h.running.join(",")}): ok`);
			return;
		}
		if (Date.now() > end)
			throw new Error(`no room for a 4 GB VM: running ${h.running.join(",")}`);
		log(`host sandbox RAM ${h.mb} MB (${h.running.join(",")}): waiting`);
		await new Promise((r) => setTimeout(r, 30_000));
	}
}

async function vmidOfMachine(w: TestWorld, machineId: string): Promise<number> {
	const r = await w.pool.query<{ vmid: number | null }>(
		"SELECT vmid FROM runtime.machines WHERE id = $1",
		[machineId],
	);
	const vmid = r.rows[0]?.vmid;
	if (vmid == null) throw new ConnectError("no VM", Code.Unavailable);
	return vmid;
}

/** `sbx-agent call <method> -` through QGA: the agent's own admin socket. */
async function agentCall(
	qga: Qga,
	vmid: number,
	path: string,
	body: JsonValue,
	timeoutMs = 60_000,
): Promise<JsonValue> {
	let r: Awaited<ReturnType<Qga["exec"]>>;
	try {
		r = await qga.exec(vmid, [AGENT_EXE, "call", path, "-"], {
			input: JSON.stringify(body),
			timeoutMs,
		});
	} catch (err) {
		throw new ConnectError(
			`QGA: ${err instanceof Error ? err.message : String(err)}`,
			Code.Unavailable,
		);
	}
	if (r.exitCode === 0) return JSON.parse(r.stdout || "{}") as JsonValue;
	if (!path.endsWith("/Info"))
		log(`agent ${path}: exit ${r.exitCode}: ${r.stderr.trim().slice(0, 500)}`);
	let e: { code?: string; message?: string } = {};
	try {
		e = JSON.parse(r.stderr) as typeof e;
	} catch {
		throw new ConnectError(
			`exit ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`,
			Code.Unavailable,
		);
	}
	const code =
		Code[
			(e.code ?? "unknown").replace(/(^|_)([a-z])/g, (_, _u, c: string) =>
				c.toUpperCase(),
			) as keyof typeof Code
		] ?? Code.Unknown;
	throw new ConnectError(e.message ?? "agent error", code);
}

/** A Connect transport per machine that runs each unary call through QGA. */
function qgaAgentClient(w: TestWorld, qga: Qga): AgentClient {
	const transport = (machineId: string): Transport => ({
		async unary<I extends DescMessage, O extends DescMessage>(
			method: DescMethodUnary<I, O>,
			_signal: AbortSignal | undefined,
			_timeoutMs: number | undefined,
			_header: HeadersInit | undefined,
			input: unknown,
		): Promise<UnaryResponse<I, O>> {
			const vmid = await vmidOfMachine(w, machineId);
			log(`agent call ${method.parent.typeName}/${method.name} on VM ${vmid}`);
			const msg = create(method.input, input as never);
			const out = await agentCall(
				qga,
				vmid,
				`${method.parent.typeName}/${method.name}`,
				toJson(method.input, msg),
			);
			return {
				stream: false,
				service: method.parent,
				method,
				header: new Headers(),
				message: fromJson(method.output, out, { ignoreUnknownFields: true }),
				trailer: new Headers(),
			};
		},
		stream: () => {
			throw new ConnectError("streams are not supported over QGA");
		},
	});
	return { transport } as unknown as AgentClient;
}

interface Info {
	boot_id?: string;
	machine_id?: string;
	hostname?: string;
	readiness?: { name?: string; state?: string }[];
}

function identityReady(info: Info): boolean {
	const p = info.readiness?.find((x) => x.name === "identity");
	return p?.state === "ready" || p?.state === "PHASE_STATE_READY";
}

/**
 * The tunnel's part, played over QGA: a running VM whose agent answers
 * System/Info with this machine's id and a ready identity has a connected
 * session on its boot (the fake world's `connected` and `phase pool_ready`
 * events); a VM that is off has none.
 */
class QgaSessions {
	readonly #seq = new Map<string, number>();
	readonly #seen = new Map<string, string>();
	#timer: ReturnType<typeof setInterval> | undefined;
	#busy = false;

	readonly w: TestWorld;
	readonly qga: Qga;
	readonly infra: () => Promise<NodeInfra>;

	constructor(w: TestWorld, qga: Qga, infra: () => Promise<NodeInfra>) {
		this.w = w;
		this.qga = qga;
		this.infra = infra;
	}

	start(): void {
		this.#timer = setInterval(() => {
			if (this.#busy) return;
			this.#busy = true;
			this.tick()
				.catch((e) => log(`sessions: ${String(e)}`))
				.finally(() => {
					this.#busy = false;
				});
		}, 2000);
	}

	stop(): void {
		clearInterval(this.#timer);
	}

	async info(vmid: number): Promise<Info | null> {
		try {
			return (await agentCall(
				this.qga,
				vmid,
				"sbx.agent.v1.System/Info",
				{},
				20_000,
			)) as Info;
		} catch {
			return null;
		}
	}

	async tick(): Promise<void> {
		const infra = await this.infra();
		const ms = await this.w.pool.query<{ id: string; vmid: number }>(
			`SELECT id, vmid FROM runtime.machines
			 WHERE vmid IS NOT NULL AND state NOT IN ('deleting', 'deleted', 'failed')`,
		);
		for (const m of ms.rows) {
			const status = await infra.status(m.vmid);
			if (status !== "running") {
				if (this.#seen.delete(m.id)) {
					log(
						`session ${m.id.slice(0, 8)}: VM ${m.vmid} ${status}, disconnected`,
					);
				}
				await this.w.pool.query(
					`UPDATE tunnel.tunnel_sessions SET state = 'disconnected', disconnected_at = now()
					 WHERE machine_id = $1 AND state = 'connected'`,
					[m.id],
				);
				continue;
			}
			const info = await this.info(m.vmid);
			if (
				!info?.boot_id ||
				uuidHex(info.machine_id ?? "") !== uuidHex(m.id) ||
				!identityReady(info)
			)
				continue;
			if (this.#seen.get(m.id) === info.boot_id) continue;
			this.#seen.set(m.id, info.boot_id);
			log(
				`session ${m.id.slice(0, 8)}: VM ${m.vmid} boot ${info.boot_id.slice(0, 8)} as ${info.hostname}`,
			);
			await this.connect(m.id, info.boot_id);
		}
	}

	async connect(machineId: string, bootId: string): Promise<void> {
		const s = await this.w.pool.query<{ epoch: string }>(
			`INSERT INTO tunnel.tunnel_sessions
			   (machine_id, instance_id, epoch, conn_id, agent_instance_id, boot_id, vmgenid,
			    agent_version, proto_version, capabilities, state, connected_at)
			 VALUES ($1, 'gw-qga', 1, gen_random_uuid(), gen_random_uuid(), $2, gen_random_uuid(),
			         'qga', '1', $3, 'connected', now())
			 ON CONFLICT (machine_id) DO UPDATE
			 SET epoch = tunnel.tunnel_sessions.epoch + 1, conn_id = EXCLUDED.conn_id,
			     agent_instance_id = EXCLUDED.agent_instance_id, boot_id = EXCLUDED.boot_id,
			     state = 'connected', connected_at = now(), disconnected_at = NULL
			 RETURNING epoch`,
			[
				machineId,
				bootId,
				[
					"process.v1",
					"system.claim.v1",
					"system.quiesce.v1",
					"system.quiesce.wipe_secrets.v1",
				],
			],
		);
		const epoch = Number(s.rows[0]?.epoch ?? 1);
		const seq = (this.#seq.get(machineId) ?? 0) + 1;
		this.#seq.set(machineId, seq);
		const time = new Date();
		await ingestAgentEvents(this.w.pool, this.w.jobs, {
			machineId,
			events: [
				{ seq, bootId, type: "phase", time, payload: { phase: "pool_ready" } },
			],
			synthetic: [{ epoch, type: "connected", instanceId: "gw-qga", time }],
		});
		await handleMachineEvents(this.w.ctx, { machineId });
	}
}

/** Logs the duration of every power and snapshot call of the real adapter. */
function timedInfra(
	inner: NodeInfra,
	marks: { what: string; at: number; ms: number }[],
): NodeInfra {
	const timed = new Set([
		"create",
		"fork",
		"start",
		"shutdown",
		"stop",
		"snapshot",
		"delete",
		"deleteSnapshot",
	]);
	return new Proxy(inner, {
		get(t, prop) {
			const v = Reflect.get(t, prop, t);
			if (typeof v !== "function") return v;
			if (!timed.has(String(prop))) return v.bind(t);
			return async (...args: unknown[]) => {
				const at = Date.now();
				log(`infra.${String(prop)}(${String(args[0])}) ...`);
				try {
					return await v.apply(t, args);
				} finally {
					const ms = Date.now() - at;
					marks.push({ what: String(prop), at, ms });
					log(`infra.${String(prop)}(${String(args[0])}) ${ms} ms`);
				}
			};
		},
	});
}

/** Runs a sandbox operation and logs its error when it did not succeed. */
async function runLogged(w: TestWorld, operationId: string): Promise<string> {
	const r = await run(w, operationId);
	if (r !== "succeeded") {
		const op = await row(w, "operations", operationId);
		log(
			`operation ${op.kind} ${r}: ${op.error_code} ${op.error_message} step ${op.step}`,
		);
		const errs = w.logs.filter(
			(l) => l.includes('"level":50') || l.includes('"level":40'),
		);
		for (const l of errs.slice(-10)) log(`worker: ${l.slice(0, 600)}`);
	}
	return r;
}

describe.skipIf(!LIVE)("forced Windows fork on pve (S9 §24.8)", () => {
	let db: TestDatabase;
	let w: TestWorld;
	let e: OpsEnv;
	let registry: PveInfraRegistry;
	let infra: NodeInfra;
	let qga: Qga;
	let sessions: QgaSessions;
	const marks: { what: string; at: number; ms: number }[] = [];
	const sandboxes: string[] = [];

	beforeAll(async () => {
		db = await createTestDatabase();
		w = await createWorld(db, {
			// The fork admits the target next to the running source; the test keeps
			// one VM powered at a time itself.
			ramCapMb: 2 * WIN_MB,
			bootTimeoutS: 900,
			timing: {
				pollMs: 500,
				supersedeCheckMs: 1000,
				ramWaitPollMs: 2000,
				ramWaitTimeoutMs: 20 * 60_000,
				cloneSlotPollMs: 1000,
				cloneSlotTimeoutMs: 10 * 60_000,
			},
		});
		await w.pool.query(
			`UPDATE runtime.providers
			 SET api_url = $2, tls_name = $3, vmid_min = $4, vmid_max = $5
			 WHERE id = $1`,
			[w.topo.providerId, PVE_URL, TLS_NAME, VMIDS.min, VMIDS.max],
		);
		await w.pool.query("UPDATE runtime.nodes SET name = 'pve' WHERE id = $1", [
			w.topo.nodeId,
		]);
		await w.pool.query(
			`UPDATE runtime.template_builds SET pve_vmid = $2, os = 'windows' WHERE id = $1`,
			[w.topo.templateBuildId, TEMPLATE_VMID],
		);
		const env = { ...process.env, SBX_NODE_SSH_HOST: SSH_HOST };
		const factory = pveClientsFromSecrets(SECRETS_DIR, env);
		registry = new PveInfraRegistry(w.pool, {
			secretsDir: SECRETS_DIR,
			env,
			clients: async (t) => {
				const c = await factory(t);
				qga = new Qga(c.api, t.nodeName);
				return c;
			},
		});
		infra = timedInfra(await registry.forNode(w.topo.nodeId), marks);
		expect(infra.templateVmids).toContain(TEMPLATE_VMID);
		expect(infra.vmidRange).toEqual(VMIDS);
		w.useInfra(infra);
		w.ctx.agent = new ConnectAgentPort(qgaAgentClient(w, qga), {
			timeoutMs: 120_000,
		});
		// Source and fork target are 4 GB each.
		const quota = w.ctx.config.teamQuota.bind(w.ctx.config);
		w.ctx.config.teamQuota = async (t) => ({
			...(await quota(t)),
			maxRamMb: 4 * WIN_MB,
		});
		e = opsEnv(w);
		sessions = new QgaSessions(w, qga, async () => infra);
		sessions.start();
		// Other threads may use VMIDs of this range too; only our leases are ours.
		const there = (await infra.listVms()).filter(
			(v) => v.vmid >= VMIDS.min && v.vmid <= VMIDS.max,
		);
		log(
			`VMs of other threads in range: ${JSON.stringify(there.map((v) => v.vmid))}`,
		);
	}, STEP_TIMEOUT);

	afterAll(async () => {
		sessions?.stop();
		try {
			if (w && infra) {
				// Delete what this run made through the worker, then by lease.
				for (const id of sandboxes) {
					try {
						const s = await row(w, "sandboxes", id);
						if (s.state !== "deleted") {
							const op = await e.svc.delete(e.p, id);
							log(`cleanup delete ${id.slice(0, 8)}: ${await run(w, op.id)}`);
						}
					} catch (err) {
						log(`cleanup delete ${id}: ${String(err)}`);
					}
				}
				await runSnapshotJobs(w).catch((err) =>
					log(`snapshot jobs: ${String(err)}`),
				);
				const leases = await w.pool.query<{ vmid: number; machine_id: string }>(
					`SELECT vmid, machine_id FROM runtime.vmid_leases
					 WHERE provider_id = $1 AND purpose = 'machine'`,
					[w.topo.providerId],
				);
				for (const l of leases.rows) {
					await infra
						.delete(l.vmid, { expectedOwner: l.machine_id })
						.catch((err) => log(`lease ${l.vmid}: ${String(err)}`));
				}
				const vms = (await infra.listVms()).filter(
					(v) => v.vmid >= VMIDS.min && v.vmid <= VMIDS.max,
				);
				const snaps = (await infra.listLvs()).filter((l) =>
					l.tags.some((t) => t.startsWith("sbx-snap-")),
				);
				log(
					`after cleanup: VMs in range ${JSON.stringify(vms.map((v) => v.vmid))}, our leases left ${(await w.pool.query("SELECT count(*)::int AS n FROM runtime.vmid_leases WHERE provider_id = $1 AND purpose = 'machine'", [w.topo.providerId])).rows[0]?.n}, sbx-snap LVs ${JSON.stringify(snaps.map((l) => l.name))}`,
				);
				log(`marks: ${JSON.stringify(marks)}`);
			}
		} finally {
			await registry?.close();
			await db?.drop();
		}
	}, STEP_TIMEOUT);

	it(
		"running Windows: 409 without the flag; with it stop → powered_off snapshot → start → fork",
		async () => {
			// 1. A running Windows sandbox through the worker's cold create.
			await roomForWindows();
			const c = await createSandbox(w, e, {
				size: "4gb",
				env: { APP_MODE: "live" },
				secrets: { API_TOKEN: "live-secret" },
				secretFiles: [],
			});
			sandboxes.push(c.sandboxId);
			let t0 = Date.now();
			expect(await runLogged(w, c.operationId)).toBe("succeeded");
			log(`source create → ready: ${Date.now() - t0} ms`);
			const src = await row(w, "sandboxes", c.sandboxId);
			expect(src.state).toBe("ready");
			const srcMachine = src.machine_id as string;
			const srcVmid = await vmidOfMachine(w, srcMachine);
			const srcInfo = await sessions.info(srcVmid);
			log(`source VM ${srcVmid} hostname ${srcInfo?.hostname}`);

			// 2. Without the flag: refused, nothing changes.
			let refused: unknown;
			try {
				await e.svc.fork(e.p, c.sandboxId, {});
			} catch (err) {
				refused = err;
			}
			expect(isSbxError(refused, "snapshot_requires_stop")).toBe(true);
			const r = refused as { message: string; details: unknown };
			log(`without forceStop: ${r.message} ${JSON.stringify(r.details)}`);
			expect(r.details).toEqual({
				reason: "windows_running",
				retryWith: { forceStop: true },
				cli: "--force-stop",
			});
			expect(await infra.status(srcVmid)).toBe("running");

			// 3. A file written right before the forced fork, never flushed.
			// In the command line: QGA stdin gives PowerShell no EOF, and the
			// Windows command line is limited to 32767 characters.
			const content = randomBytes(10_000).toString("hex");
			const sha = createHash("sha256").update(content).digest("hex");
			const wr = await qga.exec(
				srcVmid,
				[
					"powershell.exe",
					"-NoProfile",
					"-Command",
					`[IO.File]::WriteAllText('${MARKER_PATH}', '${content}')`,
				],
				{ timeoutMs: 60_000 },
			);
			expect(wr.exitCode).toBe(0);
			log(`wrote ${content.length} bytes to ${MARKER_PATH}, sha256 ${sha}`);

			// 4. Forced fork through the worker.
			const f = await forkSandbox(e, c.sandboxId, { forceStop: true });
			sandboxes.push(f.targetId);
			t0 = Date.now();
			expect(await runLogged(w, f.forkOpId)).toBe("succeeded");
			const forkMs = Date.now() - t0;
			const op = await row(w, "operations", f.forkOpId);
			log(
				`fork op ${forkMs} ms, step ${op.step}, progress ${JSON.stringify(op.progress)}`,
			);
			expect(op.progress).toMatchObject({
				forceStopped: true,
				sourceRestarted: true,
				shutdown: "clean",
			});
			const [snap] = await snapshotsOf(w, f.targetId);
			expect(snap).toMatchObject({
				state: "ready",
				consistency: "powered_off",
			});
			expect(await row(w, "machines", srcMachine)).toMatchObject({
				state: "running",
			});
			expect(await infra.status(srcVmid)).toBe("running");
			expect((await row(w, "sandboxes", c.sandboxId)).state).toBe("ready");
			const back = await sessions.info(srcVmid);
			expect(back?.boot_id).not.toBe(srcInfo?.boot_id);

			// 5. One 4 GB VM at a time: stop the source before the fork boots.
			const stop = await e.svc.stop(e.p, c.sandboxId);
			expect(await runLogged(w, stop.id)).toBe("succeeded");
			await roomForWindows();

			// 6. The fork target boots from the snapshot under a new name.
			t0 = Date.now();
			expect(await runLogged(w, f.createOpId)).toBe("succeeded");
			log(`fork target create → ready: ${Date.now() - t0} ms`);
			const tgt = await row(w, "sandboxes", f.targetId);
			expect(tgt.state).toBe("ready");
			const tgtVmid = await vmidOfMachine(w, tgt.machine_id as string);
			const tgtInfo = await sessions.info(tgtVmid);
			log(`fork VM ${tgtVmid} hostname ${tgtInfo?.hostname}`);
			expect(tgtInfo?.hostname?.toUpperCase()).toMatch(/^SBX/);
			expect(tgtInfo?.hostname).not.toBe(srcInfo?.hostname);

			// 7. The unflushed file is in the fork, whole.
			const rd = await qga.exec(
				tgtVmid,
				[
					"powershell.exe",
					"-NoProfile",
					"-Command",
					`(Get-FileHash -Algorithm SHA256 '${MARKER_PATH}').Hash`,
				],
				{ timeoutMs: 60_000 },
			);
			expect(rd.exitCode).toBe(0);
			log(`fork file sha256 ${rd.stdout.trim()}`);
			expect(rd.stdout.trim().toLowerCase()).toBe(sha);
		},
		STEP_TIMEOUT,
	);
});
