import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	familyForTunnelUrl,
	type Machines,
	type Qga,
	retryOnVmLock,
	type Smbios,
	type SnapshotRef,
	s2SerialPayload,
	VM_LOCK_AFTER_RESTART_MS,
} from "@sbx/pve";
import { devCpRegistrar } from "../../template-builder/src/devcp.ts";
import { type Ctx, RamGuard } from "./context.ts";
import { redact } from "./report.ts";
import { deleteWithRetry, machinesFor } from "./s5.ts";
import { withAbortSignals } from "./signals.ts";
import { type Summary, summarize } from "./stats.ts";

// sbx-bench s9 (spec S9 section 16): create and fork timings of the Windows template.
// One Windows VM at a time (4 GB each, RAM guard 8 GB): create A (S1) -> start -> agent ready
// -> hard stop and start -> crash-consistent snapshot without QGA/VSS -> shut A down -> fork B with a
// new identity -> start -> agent ready under the new computer name -> delete everything.

const SIZE = { cores: 2, memoryMb: 4096 };
const BOOT_TIMEOUT_MS = 10 * 60_000;
const SHUTDOWN_TIMEOUT_S = 120;
const INFO_TIMEOUT_MS = 60_000;
const TUNNEL_TIMEOUT_MS = 2 * 60_000;
/** Same path as the Windows verify profile of sbx-tpl. */
export const AGENT_EXE = "C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe";
export const INFO_CMD = [AGENT_EXE, "call", "sbx.agent.v1.System/Info", "-"];

export interface S9Options {
	template: number;
	runs: number;
	connectUrl?: string;
	devCpSsh?: string;
	keep: boolean;
	outDir: string;
	ramCapMb: number;
}

/** Milliseconds per metric of one run; null where the signal does not exist (no tunnel). */
export interface S9Run {
	createMs: number;
	createToAgentReadyMs: number;
	firstBootToAgentReadyMs: number;
	bootToAgentReadyMs: number;
	startToQgaMs: number;
	tunnelConnectedMs: number | null;
	hardStopRestartMs: number;
	forkSnapshotMs: number;
	freezeMs: number | null;
	forkCloneMs: number;
	forkStartToAgentReadyMs: number;
	forkBootToAgentReadyMs: number;
	forkToAgentReadyMs: number;
	forkTunnelConnectedMs: number | null;
}

/** Metric name, how it is measured (printed under the table) and the getter. */
export const S9_METRICS: [string, string, (r: S9Run) => number | null][] = [
	["create", "S1 create of A from the template, no boot", (r) => r.createMs],
	[
		"create_to_agent_ready",
		"create call -> start -> agent ready (and tunnel connected with --connect-url)",
		(r) => r.createToAgentReadyMs,
	],
	[
		"first_boot_to_agent_ready",
		"start of the new clone -> agent ready, includes specialize",
		(r) => r.firstBootToAgentReadyMs,
	],
	[
		"boot_to_agent_ready",
		"start after a graceful shutdown -> agent ready",
		(r) => r.bootToAgentReadyMs,
	],
	[
		"start_to_qga",
		"first boot: start -> first QGA ping",
		(r) => r.startToQgaMs,
	],
	[
		"tunnel_connected",
		"first boot: start -> tunnel session connected",
		(r) => r.tunnelConnectedMs,
	],
	[
		"hard_stop_restart",
		"start after a hard stop -> agent ready",
		(r) => r.hardStopRestartMs,
	],
	[
		"fork_snapshot_ms",
		"crash-consistent snapshot of the running A without QGA/VSS",
		(r) => r.forkSnapshotMs,
	],
	["freeze_ms", "pause -> snapshot -> resume (no VSS)", (r) => r.freezeMs],
	[
		"fork_clone_ms",
		"cloneFromSnapshot of B (disks, config, firewall), no boot",
		(r) => r.forkCloneMs,
	],
	[
		"fork_start_to_agent_ready",
		"start of B -> agent ready under the new computer name (rename reboot included)",
		(r) => r.forkStartToAgentReadyMs,
	],
	[
		"fork_boot_to_agent_ready",
		"cloneFromSnapshot -> start -> agent ready with the new name",
		(r) => r.forkBootToAgentReadyMs,
	],
	[
		"fork_to_agent_ready",
		"fork_snapshot_ms + fork_boot_to_agent_ready (A's shutdown excluded)",
		(r) => r.forkToAgentReadyMs,
	],
	[
		"fork_tunnel_connected",
		"start of B -> tunnel session connected",
		(r) => r.forkTunnelConnectedMs,
	],
];

export function summarizeS9(runs: S9Run[]): Record<string, Summary> {
	return Object.fromEntries(
		S9_METRICS.map(([name, , get]) => [
			name,
			summarize(runs.map(get).filter((x): x is number => x !== null)),
		]),
	);
}

/** Markdown table of the summary: median, p95, min, max per metric, in milliseconds. */
export function s9Markdown(
	summary: Record<string, Summary>,
	runs: number,
): string {
	const cell = (v: number | undefined) =>
		v === undefined ? "-" : String(Math.round(v));
	const rows = Object.entries(summary).map(
		([name, s]) =>
			`| ${name} | ${s.n} | ${cell(s.median)} | ${cell(s.p95)} | ${cell(s.min)} | ${cell(s.max)} |`,
	);
	return [
		`Windows template timings, ms (${runs} runs)`,
		"",
		"| metric | n | median | p95 | min | max |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
		"Definitions:",
		...S9_METRICS.map(([name, what]) => `- ${name}: ${what}`),
	].join("\n");
}

const uuidHex = (s: string) => s.replaceAll("-", "").toLowerCase();

/** Computer name of a machine (spec S9 11.2): SBX + the last 12 hex digits of its id, upper case. */
export function computerNameFor(machineId: string): string {
	return `SBX${uuidHex(machineId).slice(-12).toUpperCase()}`;
}

/** Field of a protojson object under its proto name or its lowerCamel JSON name. */
function field(obj: unknown, name: string): unknown {
	if (typeof obj !== "object" || obj === null) return undefined;
	const o = obj as Record<string, unknown>;
	if (name in o) return o[name];
	return o[name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Whether a System/Info answer shows the agent ready for this machine: machine_id equals the
 * smbios uuid, the identity phase is ready and, for a fork, the computer name is the new one
 * (the first boot of a fork reports the old name until the rename reboot).
 */
export function agentReadiness(
	info: unknown,
	want: { machineId: string; hostname?: string },
): { ready: boolean; detail: string } {
	const id = str(field(info, "machine_id"));
	const phases = field(info, "readiness");
	const identity = Array.isArray(phases)
		? str(
				field(
					phases.find((p) => field(p, "name") === "identity"),
					"state",
				),
			)
		: "";
	const host = str(field(info, "hostname"));
	const idOk = id !== "" && uuidHex(id) === uuidHex(want.machineId);
	const identityOk = identity === "ready" || identity === "PHASE_STATE_READY";
	const hostOk =
		want.hostname === undefined || host.toUpperCase() === want.hostname;
	return {
		ready: idOk && identityOk && hostOk,
		detail: `machine_id ${id || "none"}, identity ${identity || "unknown"}, hostname ${host || "none"}`,
	};
}

/** Polls System/Info over QGA until the agent is ready for the machine; times are host clock. */
export async function waitAgentReady(o: {
	qga: Pick<Qga, "ping" | "exec">;
	vmid: number;
	want: { machineId: string; hostname?: string };
	label: string;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	pollMs: number;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<{ qgaAt: number | null; readyAt: number }> {
	const deadline = o.now() + o.timeoutMs;
	let qgaAt: number | null = null;
	let last = "no answer";
	for (;;) {
		o.signal?.throwIfAborted();
		if (qgaAt === null && (await o.qga.ping(o.vmid))) qgaAt = o.now();
		if (qgaAt !== null) {
			try {
				const r = await o.qga.exec(o.vmid, INFO_CMD, {
					input: "{}",
					timeoutMs: INFO_TIMEOUT_MS,
				});
				if (r.exitCode === 0) {
					const st = agentReadiness(JSON.parse(r.stdout), o.want);
					if (st.ready) return { qgaAt, readyAt: o.now() };
					last = st.detail;
				} else
					last = `exit ${r.exitCode}: ${r.stderr.trim() || r.stdout.trim()}`;
			} catch (err) {
				// The agent or QGA is not up yet, or the VM reboots (fork rename).
				last = err instanceof Error ? err.message : String(err);
			}
		}
		if (o.now() >= deadline)
			throw new Error(
				`${o.label}: agent not ready after ${o.timeoutMs} ms: ${last}`,
			);
		await o.sleep(o.pollMs);
	}
}

/** Host rules: sandbox VMIDs 500-589, the Windows template is outside that range. */
export function checkHostRules(
	cfg: { vmidRange: { min: number; max: number } },
	template: number,
): void {
	if (cfg.vmidRange.min < 500 || cfg.vmidRange.max > 589)
		throw new Error(
			`refusing to run: VMID range ${cfg.vmidRange.min}-${cfg.vmidRange.max} is outside 500-589`,
		);
	if (template >= cfg.vmidRange.min && template <= cfg.vmidRange.max)
		throw new Error(`--template ${template} is a sandbox VMID`);
}

/** Tunnel registration on the dev control plane (the registrar of sbx-tpl verify --connect-url). */
export interface TunnelRegistrar {
	register(machineId: string, bsHashHex: string): Promise<void>;
	sessionState(machineId: string): Promise<string | null>;
	unregister(machineId: string): Promise<void>;
}

export interface S9Deps {
	machines: Pick<
		Machines,
		| "create"
		| "fork"
		| "snapshot"
		| "deleteSnapshot"
		| "start"
		| "stop"
		| "shutdown"
		| "delete"
	> & { qga: Pick<Qga, "ping" | "exec"> };
	ram: Pick<RamGuard, "reserve" | "release">;
	connect?: { url: string; registrar: TunnelRegistrar };
	keep: boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
	bootTimeoutMs?: number;
	tunnelTimeoutMs?: number;
	randomUUID?: () => string;
	log?: (text: string) => void;
	/** Aborts the run; what it made is still removed. */
	signal?: AbortSignal;
	/** Called with every secret of a run (serial payloads) for redaction of the output. */
	secret?: (s: string) => void;
}

const defaultLog = (s: string) =>
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);

/** One run: create, boot, hard restart, snapshot, fork. Everything it made is removed at the end. */
export async function runS9Once(deps: S9Deps): Promise<S9Run> {
	const { machines, ram, connect } = deps;
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const pollMs = deps.pollMs ?? 1000;
	const bootTimeoutMs = deps.bootTimeoutMs ?? BOOT_TIMEOUT_MS;
	const tunnelTimeoutMs = deps.tunnelTimeoutMs ?? TUNNEL_TIMEOUT_MS;
	const uuid = deps.randomUUID ?? randomUUID;
	const log = deps.log ?? defaultLog;
	const { signal } = deps;
	const family = connect ? familyForTunnelUrl(connect.url) : undefined;

	const identity = () => {
		const id = uuid();
		const bs = randomBytes(32);
		const serial = s2SerialPayload(id, bs);
		deps.secret?.(serial);
		deps.secret?.(Buffer.from(serial).toString("base64"));
		const smbios: Smbios = {
			uuid: id,
			serial,
			...(family !== undefined ? { family } : {}),
		};
		return { uuid: id, bs, smbios };
	};

	const waitAgent = (
		vmid: number,
		want: { machineId: string; hostname?: string },
		label: string,
	) =>
		waitAgentReady({
			qga: machines.qga,
			vmid,
			want,
			label,
			now,
			sleep,
			pollMs,
			timeoutMs: bootTimeoutMs,
			...(signal !== undefined ? { signal } : {}),
		});

	const waitTunnel = async (id: string, label: string): Promise<number> => {
		if (!connect) throw new Error("no tunnel registrar");
		const deadline = now() + tunnelTimeoutMs;
		let last = "no session";
		for (;;) {
			signal?.throwIfAborted();
			try {
				const st = await connect.registrar.sessionState(id);
				if (st?.startsWith("connected")) return now();
				last = st === null ? "no session" : `session ${st}`;
			} catch (err) {
				last = err instanceof Error ? err.message : String(err);
			}
			if (now() >= deadline)
				throw new Error(
					`${label}: tunnel not connected after ${tunnelTimeoutMs} ms: ${last}`,
				);
			await sleep(pollMs);
		}
	};

	const register = async (id: { uuid: string; bs: Buffer }) => {
		await connect?.registrar.register(
			id.uuid,
			createHash("sha256").update(id.bs).digest("hex"),
		);
	};

	const a = identity();
	const b = identity();
	let vmA: number | undefined;
	let vmB: number | undefined;
	let snap: SnapshotRef | undefined;
	const registered: string[] = [];
	const reserved = new Set<number>();
	const reserve = async (vmid: number) => {
		await ram.reserve(vmid, SIZE.memoryMb);
		reserved.add(vmid);
	};
	const release = (vmid: number) => {
		if (reserved.delete(vmid)) ram.release(vmid);
	};

	let failure: unknown;
	let result: S9Run | undefined;
	try {
		if (connect) {
			await register(a);
			registered.push(a.uuid);
		}
		log("create A from the template");
		const createAt = now();
		vmA = (await machines.create({ size: SIZE, smbios: a.smbios })).vmid;
		const createMs = now() - createAt;
		await reserve(vmA);
		signal?.throwIfAborted();

		log(`VM ${vmA}: start`);
		const startAt = now();
		await machines.start(vmA);
		const first = await waitAgent(vmA, { machineId: a.uuid }, `VM ${vmA}`);
		const tunnelAt = connect ? await waitTunnel(a.uuid, `VM ${vmA}`) : null;
		const readyAt = tunnelAt ?? first.readyAt;
		log(
			`VM ${vmA}: agent ready ${first.readyAt - startAt} ms after start${tunnelAt !== null ? `, tunnel ${tunnelAt - startAt} ms` : ""}`,
		);

		signal?.throwIfAborted();
		log(`VM ${vmA}: hard stop and start`);
		await retryOnVmLock(() => machines.stop(vmA as number));
		const restartAt = now();
		await machines.start(vmA);
		const again = await waitAgent(vmA, { machineId: a.uuid }, `VM ${vmA}`);
		const hardStopRestartMs = again.readyAt - restartAt;
		log(`VM ${vmA}: restart to agent ready ${hardStopRestartMs} ms`);

		signal?.throwIfAborted();
		// qmeventd may still hold the VM lock after the restart, and the snapshot would wait for
		// it inside the freeze budget: wait it out so freeze_ms measures the freeze.
		const settle = restartAt + VM_LOCK_AFTER_RESTART_MS - now();
		if (settle > 0) {
			log(`VM ${vmA}: waiting ${settle} ms for the VM lock after the restart`);
			await sleep(settle);
		}
		log(`VM ${vmA}: snapshot (Windows crash fallback, no QGA/VSS)`);
		// The lock may still be busy (retryOnVmLock); only the attempt that succeeds is timed.
		let snapAt = 0;
		snap = await retryOnVmLock(
			() => {
				snapAt = now();
				return machines.snapshot(vmA as number);
			},
			{
				onRetry: (err) => log(`VM ${vmA}: snapshot: ${String(err)}; retrying`),
			},
		);
		const forkSnapshotMs = now() - snapAt;
		const freezeMs = snap.freezeMs ?? null;
		log(
			`snapshot ${snap.id}: ${forkSnapshotMs} ms, paused ${freezeMs ?? "-"} ms`,
		);

		// One Windows VM at a time: A is off before it starts again and before B starts.
		const shutdownA = async () => {
			signal?.throwIfAborted();
			log(`VM ${vmA}: shutdown`);
			await machines
				.shutdown(vmA as number, SHUTDOWN_TIMEOUT_S)
				.catch(async (err) => {
					log(`VM ${vmA}: shutdown failed (${String(err)}), hard stop`);
					await retryOnVmLock(() => machines.stop(vmA as number));
				});
		};
		await shutdownA();
		log(`VM ${vmA}: normal boot`);
		const bootAt = now();
		await machines.start(vmA);
		const normal = await waitAgent(vmA, { machineId: a.uuid }, `VM ${vmA}`);
		const bootToAgentReadyMs = normal.readyAt - bootAt;
		log(`VM ${vmA}: boot to agent ready ${bootToAgentReadyMs} ms`);
		await shutdownA();
		release(vmA);

		signal?.throwIfAborted();
		if (connect) {
			await register(b);
			registered.push(b.uuid);
		}
		log("fork B from the snapshot with a new identity");
		const forkAt = now();
		vmB = (await machines.fork(snap, { size: SIZE, smbios: b.smbios })).vmid;
		const forkCloneMs = now() - forkAt;
		await reserve(vmB);
		log(`VM ${vmB}: start`);
		const forkStartAt = now();
		await machines.start(vmB);
		const name = computerNameFor(b.uuid);
		const fork = await waitAgent(
			vmB,
			{ machineId: b.uuid, hostname: name },
			`VM ${vmB}`,
		);
		const forkTunnelAt = connect ? await waitTunnel(b.uuid, `VM ${vmB}`) : null;
		const forkReadyAt = forkTunnelAt ?? fork.readyAt;
		log(
			`VM ${vmB}: agent ready as ${name} ${forkReadyAt - forkStartAt} ms after start`,
		);

		result = {
			createMs,
			createToAgentReadyMs: readyAt - createAt,
			firstBootToAgentReadyMs: readyAt - startAt,
			bootToAgentReadyMs,
			startToQgaMs: (first.qgaAt ?? first.readyAt) - startAt,
			tunnelConnectedMs: tunnelAt !== null ? tunnelAt - startAt : null,
			hardStopRestartMs,
			forkSnapshotMs,
			freezeMs,
			forkCloneMs,
			forkStartToAgentReadyMs: forkReadyAt - forkStartAt,
			forkBootToAgentReadyMs: forkReadyAt - forkAt,
			// Snapshot + (cloneFromSnapshot -> start -> ready), R13.
			forkToAgentReadyMs: forkSnapshotMs + (forkReadyAt - forkAt),
			forkTunnelConnectedMs:
				forkTunnelAt !== null ? forkTunnelAt - forkStartAt : null,
		};
	} catch (err) {
		failure = err;
	}

	// Cleanup runs after success and failure alike; a failure of the run is reported first.
	{
		const problems: string[] = [];
		const attempt = async (what: string, fn: () => Promise<unknown>) => {
			try {
				await fn();
			} catch (err) {
				problems.push(
					`${what}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		};
		if (!deps.keep) {
			// Clones before the snapshot they came from.
			for (const vmid of [vmB, vmA])
				if (vmid !== undefined)
					await attempt(`delete VM ${vmid}`, () =>
						deleteWithRetry(machines, vmid),
					);
			if (snap) {
				const s = snap;
				await attempt(`delete snapshot ${s.id}`, () =>
					machines.deleteSnapshot(s),
				);
			}
		}
		for (const vmid of reserved) ram.release(vmid);
		for (const id of registered)
			await attempt(`unregister ${id}`, () =>
				(connect as NonNullable<typeof connect>).registrar.unregister(id),
			);
		for (const p of problems) log(`cleanup: ${p}`);
		if (failure !== undefined) throw failure;
		if (problems.length > 0 || result === undefined)
			throw new Error(`cleanup failed: ${problems.join("; ")}`);
	}
	return result;
}

export async function runS9(ctx: Ctx, o: S9Options): Promise<number> {
	const { cfg } = ctx;
	checkHostRules(cfg, o.template);
	if (o.connectUrl !== undefined && o.devCpSsh === undefined)
		throw new Error("--connect-url needs --dev-cp-ssh");
	const secrets: string[] = [];
	const machines = machinesFor(ctx, o.template);
	const base: Omit<S9Deps, "keep"> = {
		machines,
		ram: new RamGuard(ctx, o.ramCapMb),
		...(o.connectUrl !== undefined && o.devCpSsh !== undefined
			? {
					connect: {
						url: o.connectUrl,
						registrar: devCpRegistrar({ ctSsh: o.devCpSsh }),
					},
				}
			: {}),
		secret: (s) => secrets.push(s),
	};

	const runs: S9Run[] = [];
	let error: string | undefined;
	await withAbortSignals(async (signal) => {
		for (let i = 1; i <= o.runs && !signal.aborted; i++) {
			try {
				process.stderr.write(`s9 run ${i}/${o.runs}\n`);
				runs.push(await runS9Once({ ...base, keep: o.keep, signal }));
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
				process.stderr.write(`s9 run ${i} failed: ${error}\n`);
				break;
			}
		}
	});

	const summary = summarizeS9(runs);
	const md = s9Markdown(summary, runs.length);
	process.stdout.write(`${md}\n`);
	mkdirSync(o.outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = join(o.outDir, `s9-${stamp}.json`);
	writeFileSync(
		file,
		`${JSON.stringify(redact({ options: o, summary, runs, markdown: md, ...(error !== undefined ? { error } : {}) }, secrets), null, 2)}\n`,
	);
	writeFileSync(join(o.outDir, `s9-${stamp}.md`), `${md}\n`);
	process.stderr.write(`results: ${file}\n`);
	return error === undefined ? 0 : 1;
}
