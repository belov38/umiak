import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatSmbios1,
	type MachineInfo,
	type MachineSize,
	type Smbios,
	type SnapshotRef,
	s2SerialPayload,
} from "@sbx/pve";
import {
	type Check,
	check,
	dmi,
	type NetTargets,
	networkChecks,
	pingBlocked,
	tcp,
	tcpBlocked,
} from "./checks.ts";
import { type Ctx, RamGuard } from "./context.ts";
import { preflight } from "./preflight.ts";
import { redact, table } from "./report.ts";
import { type Summary, summarize } from "./stats.ts";
import { diffWorld, type World } from "./world.ts";

export interface S1Options {
	runs: number;
	size: MachineSize;
	parallel: number[];
	cloneOnly: number;
	ramCapMb: number;
	baseline: boolean;
	keep: boolean;
	outDir: string;
}

const METRICS = [
	"clone",
	"clone_baseline",
	"boot",
	"ip",
	"snapshot",
	"freeze",
	"fork_clone",
	"fork",
	"delete",
] as const;
type Metric = (typeof METRICS)[number];

interface BatchResult {
	k: number;
	totalMs: number;
	perVmMs: number[];
	errors: string[];
	retries: number;
}

const DEFAULT_TARGETS = {
	lanGateway: "192.168.68.1",
	hostLan: "192.168.68.116",
	hostTailscale: "100.64.10.2",
	vnetGateway: "10.88.0.1",
};

function testSmbios(): Smbios {
	const uuid = randomUUID();
	return { uuid, serial: s2SerialPayload(uuid, randomBytes(32)) };
}

const ms = (t0: number) => Date.now() - t0;
const sec = (v: number | undefined) =>
	v === undefined ? "-" : (v / 1000).toFixed(2);
const log = (s: string) =>
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);

export async function runS1(ctx: Ctx, o: S1Options): Promise<number> {
	const { api, node, machines, cfg } = ctx;
	const startedAt = new Date();
	const samples: Record<Metric, number[]> = Object.fromEntries(
		METRICS.map((m) => [m, []]),
	) as unknown as Record<Metric, number[]>;
	const checks: Check[] = [];
	const secrets: string[] = [];
	const live = new Set<number>();
	const liveSnaps = new Map<string, SnapshotRef>();
	const ram = new RamGuard(ctx, o.ramCapMb);
	const parallel: BatchResult[] = [];
	let cloneOnly: BatchResult | undefined;
	let baselineParallel: BatchResult | undefined;
	let serialVisibility: Record<string, boolean> | undefined;
	let worldDiff: string[] = [];

	const newSmbios = () => {
		const s = testSmbios();
		secrets.push(s.serial, Buffer.from(s.serial).toString("base64"), s.uuid);
		return s;
	};
	const create = async (smbios?: Smbios) => {
		const m = await machines.create(
			smbios ? { size: o.size, smbios } : { size: o.size },
		);
		live.add(m.vmid);
		return m;
	};
	const start = async (vmid: number) => {
		await ram.reserve(vmid, o.size.memoryMb);
		const t0 = Date.now();
		await machines.start(vmid);
		const r = await machines.waitReady(vmid, { startedAt: t0 });
		return { t0, ...r };
	};
	const del = async (vmid: number) => {
		const t0 = Date.now();
		await machines.delete(vmid);
		live.delete(vmid);
		ram.release(vmid);
		return ms(t0);
	};

	// 0. Preflight and the world before.
	const pf = await preflight(ctx);
	checks.push(
		...pf.checks.map((c) => ({ ...c, name: `preflight: ${c.name}` })),
	);
	const pfFailed = pf.checks.filter((c) => !c.ok);
	if (pfFailed.length > 0) {
		for (const c of pfFailed)
			log(`preflight FAILED: ${c.name} ${c.detail ?? ""}`);
		return 1;
	}
	const targets: NetTargets = {
		...DEFAULT_TARGETS,
		hostLinkLocal: pf.inventory?.sbx0.linkLocal ?? "",
		denyPublic: (process.env.SBX_DENY_PUBLIC_IPS ?? "")
			.split(/\s+/)
			.filter(Boolean),
	};
	const before = await node.call<World>("inventory");
	const version = await api.get<{ version: string }>("/version");
	const nodeVersion = await node.call<{ version: string; kernel: string }>(
		"version",
	);

	try {
		// 1. Create, network, snapshot, fork, delete; N times.
		for (let run = 1; run <= o.runs; run++) {
			log(`run ${run}/${o.runs}: create A`);
			const smA = newSmbios();
			const tSearch = Math.floor(Date.now() / 1000) - 5;
			let t0 = Date.now();
			const a = await create(smA);
			samples.clone.push(ms(t0));
			const ra = await start(a.vmid);
			samples.boot.push(ra.pingAt - ra.t0);
			samples.ip.push(ra.ipAt - ra.t0);
			checks.push({
				name: `run${run} A ${a.vmid} got ${ra.ip} by DHCP in 10.88.0.0/24`,
				ok: true,
			});

			if (run === 1)
				serialVisibility = await serialSeen(ctx, a.vmid, smA, tSearch);

			checks.push(
				...(await networkChecks(machines.qga, a.vmid, ra.ifname, targets)),
			);
			checks.push(
				await check(
					`run${run} A dmi serial and uuid match smbios1`,
					async () => {
						const d = await dmi(machines.qga, a.vmid);
						return d.serial === smA.serial && d.uuid === smA.uuid.toLowerCase();
					},
				),
			);

			const marker1 = randomBytes(16).toString("hex");
			await machines.qga.bash(
				a.vmid,
				`echo ${marker1} > /root/marker1 && sync`,
			);
			log(`run ${run}: snapshot A`);
			t0 = Date.now();
			const snap = await machines.snapshot(a.vmid);
			liveSnaps.set(snap.id, snap);
			samples.snapshot.push(ms(t0));
			if (snap.freezeMs !== undefined) samples.freeze.push(snap.freezeMs);
			await machines.qga.bash(a.vmid, "echo two > /root/marker2 && sync");

			log(`run ${run}: fork F`);
			const smF = newSmbios();
			t0 = Date.now();
			const f = await machines.fork(snap, { size: o.size, smbios: smF });
			live.add(f.vmid);
			samples.fork_clone.push(ms(t0));
			const rf = await start(f.vmid);
			samples.fork.push(rf.pingAt - t0);

			checks.push(
				...(await forkChecks(ctx, run, a, f, smA, smF, ra.ip, rf.ip, marker1)),
			);

			log(`run ${run}: delete`);
			samples.delete.push(await del(a.vmid));
			samples.delete.push(await del(f.vmid));
			checks.push(
				await check(
					`run${run} snapshot ${snap.id} deleted with its LVs and record`,
					async () => {
						await machines.deleteSnapshot(snap);
						liveSnaps.delete(snap.id);
						return true;
					},
				),
			);
		}

		// 2. Parallel create -> start -> ready.
		for (const k of o.parallel) {
			log(`parallel k=${k}`);
			const r = await batch(ctx, k, async () => {
				const m = await create();
				await start(m.vmid);
				return m.vmid;
			});
			parallel.push(r.result);
			checks.push({
				name: `parallel k=${k} without errors`,
				ok: r.result.errors.length === 0,
				detail: r.result.errors.join("; "),
			});
			checks.push(...(await deleteAll(r.vmids, del, `parallel k=${k}`)));
		}

		// 3. Clone-only contention.
		if (o.cloneOnly > 0) {
			log(`clone-only ${o.cloneOnly}`);
			const r = await batch(
				ctx,
				o.cloneOnly,
				async () => (await create()).vmid,
			);
			cloneOnly = r.result;
			checks.push({
				name: `clone-only ${o.cloneOnly} without errors`,
				ok: r.result.errors.length === 0,
				detail: r.result.errors.join("; "),
			});
			checks.push(...(await deleteAll(r.vmids, del, "clone-only")));
		}

		// 4. Baseline: qm clone through the API.
		if (o.baseline) {
			for (let run = 1; run <= o.runs; run++) {
				log(`baseline ${run}/${o.runs}`);
				const t0 = Date.now();
				const m = await machines.createViaQmClone({ size: o.size });
				live.add(m.vmid);
				samples.clone_baseline.push(ms(t0));
				await del(m.vmid);
			}
			log("baseline parallel k=4");
			const r = await batch(ctx, 4, async () => {
				const m = await machines.createViaQmClone({ size: o.size });
				live.add(m.vmid);
				return m.vmid;
			});
			baselineParallel = r.result;
			checks.push({
				name: "baseline parallel k=4 without errors",
				ok: r.result.errors.length === 0,
				detail: r.result.errors.join("; "),
			});
			checks.push(...(await deleteAll(r.vmids, del, "baseline parallel")));
		}
	} catch (err) {
		checks.push({
			name: "scenario completed",
			ok: false,
			detail: (err as Error).stack ?? String(err),
		});
	} finally {
		if (!o.keep) {
			for (const vmid of [...live]) {
				try {
					await del(vmid);
				} catch (err) {
					checks.push({
						name: `cleanup VM ${vmid}`,
						ok: false,
						detail: (err as Error).message,
					});
				}
			}
			for (const s of liveSnaps.values()) {
				await machines.deleteSnapshot(s).catch((err: Error) =>
					checks.push({
						name: `cleanup snapshot ${s.id}`,
						ok: false,
						detail: err.message,
					}),
				);
			}
		}
	}

	// 5. The world after.
	if (!o.keep) {
		const after = await node.call<World>("inventory");
		worldDiff = diffWorld(before, after);
		checks.push({
			name: "world before == world after",
			ok: worldDiff.length === 0,
			detail: worldDiff.join("\n"),
		});
	}

	// Leftovers the world diff does not cover: sandbox LVs, leases and ethers, allocator rows, pool VMs.
	if (!o.keep) {
		const after = await preflight(ctx);
		for (const c of after.checks.filter((x) =>
			x.name.startsWith("no leftover"),
		)) {
			checks.push({ ...c, name: `after run: ${c.name}` });
		}
	}

	const summary = Object.fromEntries(
		METRICS.map((m) => [m, summarize(samples[m])]),
	) as Record<Metric, Summary>;
	const result = redact(
		{
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
			gitCommit: gitCommit(),
			proxmox: version.version,
			kernel: nodeVersion.kernel,
			sbxNode: nodeVersion.version,
			storage: `${cfg.storage} (VG pve, thin pool data, Crucial P310 QLC)`,
			templateVmid: cfg.templateVmid,
			size: o.size,
			options: { ...o, outDir: undefined },
			summary,
			samples,
			parallel,
			cloneOnly,
			baselineParallel,
			serialVisibility,
			checks,
			worldDiff,
		},
		secrets,
	);

	printReport(
		result.summary,
		parallel,
		cloneOnly,
		baselineParallel,
		serialVisibility,
		result.checks,
	);
	mkdirSync(o.outDir, { recursive: true });
	const file = join(
		o.outDir,
		`s1-${startedAt.toISOString().replace(/[:.]/g, "-")}.json`,
	);
	writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
	log(`results: ${file}`);
	return result.checks.every((c) => c.ok) ? 0 : 1;
}

async function forkChecks(
	ctx: Ctx,
	run: number,
	a: MachineInfo,
	f: MachineInfo,
	smA: Smbios,
	smF: Smbios,
	ipA: string,
	ipF: string,
	marker1: string,
): Promise<Check[]> {
	const { machines } = ctx;
	const q = machines.qga;
	const p = `run${run} F ${f.vmid}`;
	const c: Check[] = [];
	c.push(
		await check(`${p} has marker1 with the same content`, async () => {
			const r = await q.bash(f.vmid, "cat /root/marker1");
			return r.stdout.trim() === marker1;
		}),
	);
	c.push(
		await check(
			`${p} has no marker2`,
			async () =>
				(await q.bash(f.vmid, "test -e /root/marker2")).exitCode === 1,
		),
	);
	const [cfgA, cfgF] = await Promise.all([
		machines.config(a.vmid),
		machines.config(f.vmid),
	]);
	c.push(
		await check(`${p} https works (egress positive control)`, async () => {
			const r = await q.exec(
				f.vmid,
				[
					"curl",
					"-fsS",
					"-o",
					"/dev/null",
					"--max-time",
					"10",
					"https://example.com",
				],
				{
					timeoutMs: 30_000,
				},
			);
			return { ok: r.exitCode === 0, detail: r.stderr.trim() };
		}),
	);
	c.push({
		name: `${p} VMID and MAC differ from A`,
		ok: a.vmid !== f.vmid && a.mac !== f.mac,
	});
	c.push({
		name: `${p} vmgenid differs from A`,
		ok: !!cfgA.vmgenid && !!cfgF.vmgenid && cfgA.vmgenid !== cfgF.vmgenid,
	});
	c.push({
		name: `${p} smbios1 in config is F's own`,
		ok:
			cfgF.smbios1 === formatSmbios1(smF) &&
			cfgA.smbios1 === formatSmbios1(smA),
	});
	c.push(
		await check(`${p} dmi serial and uuid are F's own`, async () => {
			const d = await dmi(q, f.vmid);
			return (
				d.serial === smF.serial &&
				d.uuid === smF.uuid.toLowerCase() &&
				d.serial !== smA.serial
			);
		}),
	);
	c.push({ name: `${p} IP ${ipF} differs from A ${ipA}`, ok: ipA !== ipF });
	c.push(
		await check(
			`${p} sshd listens locally in A and F (positive control)`,
			async () => {
				const [ra, rf] = await Promise.all([
					tcp(q, a.vmid, "127.0.0.1", 22),
					tcp(q, f.vmid, "127.0.0.1", 22),
				]);
				return {
					ok: ra === "open" && rf === "open",
					detail: `A ${ra} F ${rf}`,
				};
			},
		),
	);
	c.push(
		await check(`${p} A -> F ping blocked`, () => pingBlocked(q, a.vmid, ipF)),
	);
	c.push(
		await check(`${p} F -> A ping blocked`, () => pingBlocked(q, f.vmid, ipA)),
	);
	c.push(
		await check(`${p} A -> F tcp 22 blocked`, () =>
			tcpBlocked(q, a.vmid, ipF, 22),
		),
	);
	c.push(
		await check(`${p} F -> A tcp 22 blocked`, () =>
			tcpBlocked(q, f.vmid, ipA, 22),
		),
	);
	return c;
}

/** Where the test serial is visible: VM config (API), host journal, task logs, QEMU command line. */
async function serialSeen(
	ctx: Ctx,
	vmid: number,
	sm: Smbios,
	since: number,
): Promise<Record<string, boolean>> {
	const b64 = Buffer.from(sm.serial).toString("base64");
	const config = await ctx.machines.config(vmid);
	const out: Record<string, boolean> = {
		config: (config.smbios1 ?? "").includes(b64),
	};
	for (const needle of [b64, sm.serial]) {
		const r = await ctx.node.call<{ search: Record<string, boolean> }>(
			"inventory",
			{ sections: ["search"], search: needle, since },
		);
		for (const [k, v] of Object.entries(r.search))
			out[k] = (out[k] ?? false) || v;
	}
	return out;
}

async function batch(
	ctx: Ctx,
	k: number,
	one: () => Promise<number>,
): Promise<{ result: BatchResult; vmids: number[] }> {
	const retries0 = ctx.api.retryCount;
	const t0 = Date.now();
	const settled = await Promise.allSettled(
		Array.from({ length: k }, async () => {
			const s = Date.now();
			const vmid = await one();
			return { vmid, ms: ms(s) };
		}),
	);
	const totalMs = ms(t0);
	const ok = settled
		.filter((s) => s.status === "fulfilled")
		.map((s) => s.value);
	const errors = settled
		.filter((s) => s.status === "rejected")
		.map((s) => String((s.reason as Error).message));
	return {
		result: {
			k,
			totalMs,
			perVmMs: ok.map((x) => x.ms),
			errors,
			retries: ctx.api.retryCount - retries0,
		},
		vmids: ok.map((x) => x.vmid),
	};
}

async function deleteAll(
	vmids: number[],
	del: (vmid: number) => Promise<number>,
	label: string,
): Promise<Check[]> {
	const settled = await Promise.allSettled(vmids.map((v) => del(v)));
	const errors = settled
		.filter((s) => s.status === "rejected")
		.map((s) => String((s.reason as Error).message));
	return [
		{
			name: `${label}: delete all without traces`,
			ok: errors.length === 0,
			detail: errors.join("; "),
		},
	];
}

function gitCommit(): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return "unknown";
	}
}

function printReport(
	summary: Record<Metric, Summary>,
	parallel: BatchResult[],
	cloneOnly: BatchResult | undefined,
	baselineParallel: BatchResult | undefined,
	serial: Record<string, boolean> | undefined,
	checks: Check[],
): void {
	const out: string[] = [];
	out.push("Metrics, seconds (p95 is nearest-rank; with n < 20 it equals max)");
	out.push(
		table(
			["metric", "n", "median", "p95", "min", "max"],
			METRICS.map((m) => [
				m,
				summary[m].n,
				sec(summary[m].median),
				sec(summary[m].p95),
				sec(summary[m].min),
				sec(summary[m].max),
			]),
		),
	);
	const batches = [...parallel.map((b) => ({ label: `parallel k=${b.k}`, b }))];
	if (cloneOnly)
		batches.push({ label: `clone-only ${cloneOnly.k}`, b: cloneOnly });
	if (baselineParallel)
		batches.push({ label: "baseline clone k=4", b: baselineParallel });
	if (batches.length > 0) {
		out.push("", "Batches, seconds");
		out.push(
			table(
				[
					"batch",
					"total",
					"per-VM median",
					"per-VM max",
					"errors",
					"API retries",
				],
				batches.map(({ label, b }) => {
					const s = summarize(b.perVmMs);
					return [
						label,
						sec(b.totalMs),
						sec(s.median),
						sec(s.max),
						b.errors.length,
						b.retries,
					];
				}),
			),
		);
	}
	if (serial)
		out.push(
			"",
			`Test serial visible in: ${Object.entries(serial)
				.map(([k, v]) => `${k}=${v ? "yes" : "no"}`)
				.join(", ")}`,
		);
	const failed = checks.filter((c) => !c.ok);
	out.push(
		"",
		`Checks: ${checks.length - failed.length}/${checks.length} passed`,
	);
	for (const c of failed)
		out.push(`  FAIL ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
	process.stdout.write(`${out.join("\n")}\n`);
}
