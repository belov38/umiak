import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Machines, s2SerialPayload } from "@sbx/pve";
import { type Ctx, RamGuard } from "./context.ts";
import { redact, table } from "./report.ts";
import { type Summary, summarize } from "./stats.ts";

// sbx-bench s5 (spec S5 section 13.1): boot timing of a template build against a baseline.
// One VM at a time: create (S1, 2 vCPU / 2 GB) -> start -> measure -> hard stop -> start ->
// measure -> delete.

const SIZE = { cores: 2, memoryMb: 2048 };
const BOOT_TIMEOUT_MS = 300_000;

export interface S5Options {
	template: number;
	baseline?: number;
	runs: number;
	ramCapMb: number;
	keep: boolean;
	outDir: string;
}

/** One boot of one clone; null where the template has no such signal (599 has no agent). */
export interface BootSample {
	startToQgaMs: number;
	startToIpMs: number;
	startToAgentReadyMs: number | null;
	kernelMs: number | null;
	initrdMs: number | null;
	userspaceMs: number | null;
}

export interface RunSample {
	first: BootSample;
	hardStopRestart: BootSample;
	criticalChain: string;
	blameTop10: string[];
}

const toMs = (v: string, unit: string): number =>
	Number(v) * (unit === "min" ? 60_000 : unit === "ms" ? 1 : 1000);

/** Sums "1min 2.5s"-style durations. */
function duration(text: string): number {
	let ms = 0;
	for (const m of text.matchAll(/(\d+(?:\.\d+)?)(min|ms|s)\b/g))
		ms += toMs(m[1] as string, m[2] as string);
	return Math.round(ms);
}

/**
 * The first line of `systemd-analyze`: "Startup finished in 1.2s (kernel) + 800ms (initrd) +
 * 3.4s (userspace) = ...". initrd is absent when the image boots without one.
 */
export function parseSystemdAnalyze(text: string): {
	kernelMs: number | null;
	initrdMs: number | null;
	userspaceMs: number | null;
} {
	const part = (name: string) => {
		const m = new RegExp(
			`((?:\\d+(?:\\.\\d+)?(?:min|ms|s)\\s*)+)\\(${name}\\)`,
		).exec(text);
		return m ? duration(m[1] as string) : null;
	};
	return {
		kernelMs: part("kernel"),
		initrdMs: part("initrd"),
		userspaceMs: part("userspace"),
	};
}

/**
 * Host time of an event inside the guest, relative to the start call: the guest's kernel
 * started at `pingHostMs - uptimeS * 1000` (host clock), the event is `monotonicUs` after that.
 */
export function agentReadyMs(
	startHostMs: number,
	pingHostMs: number,
	uptimeS: number,
	activeEnterMonotonicUs: number,
): number | null {
	if (!(activeEnterMonotonicUs > 0)) return null;
	const kernelStart = pingHostMs - uptimeS * 1000;
	return Math.round(kernelStart + activeEnterMonotonicUs / 1000 - startHostMs);
}

const GUEST_SCRIPT = [
	"cat /proc/uptime",
	"systemctl show -p ActiveEnterTimestampMonotonic --value sbx-agent.service 2>/dev/null || echo 0",
	"systemd-analyze 2>/dev/null | head -1",
	"echo ---",
	"systemd-analyze critical-chain sbx-agent.service 2>/dev/null | tail -n +3 | head -15",
	"echo ---",
	"systemd-analyze blame 2>/dev/null | head -10",
].join("\n");

const log = (s: string) =>
	process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);

export async function runS5(ctx: Ctx, o: S5Options): Promise<number> {
	const { cfg } = ctx;
	const ram = new RamGuard(ctx, o.ramCapMb);
	const secrets: string[] = [];
	const machinesFor = (templateVmid: number) =>
		new Machines({
			api: ctx.api,
			node: ctx.node,
			driver: ctx.driver,
			allocator: ctx.allocator,
			snapshots: ctx.store,
			cfg: { ...cfg, templateVmid },
			ipfilter: true,
		});

	const boot = async (
		machines: Machines,
		vmid: number,
	): Promise<{ sample: BootSample; chain: string; blame: string[] }> => {
		const startedAt = Date.now();
		await machines.start(vmid);
		const ready = await machines.waitReady(vmid, {
			startedAt,
			timeoutMs: BOOT_TIMEOUT_MS,
		});
		// Give the agent and systemd-analyze a moment: "Startup finished" needs boot completion.
		let out = "";
		for (let i = 0; i < 30; i++) {
			const r = await machines.qga.exec(vmid, ["bash", "-c", GUEST_SCRIPT]);
			out = r.stdout;
			if (/Startup finished/.test(out)) break;
			await new Promise((res) => setTimeout(res, 2000));
		}
		const [head = "", chain = "", blame = ""] = out.split("---\n");
		const lines = head.split("\n");
		const uptimeS = Number((lines[0] ?? "0").split(" ")[0]);
		const active = Number(lines[1] ?? "0");
		const analyze = parseSystemdAnalyze(lines.slice(2).join("\n"));
		return {
			sample: {
				startToQgaMs: ready.pingAt - startedAt,
				startToIpMs: ready.ipAt - startedAt,
				startToAgentReadyMs: agentReadyMs(
					startedAt,
					ready.pingAt,
					uptimeS,
					active,
				),
				...analyze,
			},
			chain: chain.trim(),
			blame: blame.trim().split("\n").filter(Boolean),
		};
	};

	const runTemplate = async (templateVmid: number): Promise<RunSample[]> => {
		const machines = machinesFor(templateVmid);
		const runs: RunSample[] = [];
		for (let i = 1; i <= o.runs; i++) {
			const uuid = randomUUID();
			const serial = s2SerialPayload(uuid, randomBytes(32));
			secrets.push(serial, Buffer.from(serial).toString("base64"));
			log(`template ${templateVmid} run ${i}/${o.runs}: create`);
			const m = await machines.create({ size: SIZE, smbios: { uuid, serial } });
			try {
				await ram.reserve(m.vmid, SIZE.memoryMb);
				const first = await boot(machines, m.vmid);
				log(
					`VM ${m.vmid}: QGA ${first.sample.startToQgaMs} ms, agent ${first.sample.startToAgentReadyMs ?? "-"} ms`,
				);
				await machines.stop(m.vmid);
				const again = await boot(machines, m.vmid);
				log(
					`VM ${m.vmid}: after hard stop QGA ${again.sample.startToQgaMs} ms`,
				);
				runs.push({
					first: first.sample,
					hardStopRestart: again.sample,
					criticalChain: first.chain,
					blameTop10: first.blame,
				});
			} finally {
				if (!o.keep) await machines.delete(m.vmid);
				ram.release(m.vmid);
			}
		}
		return runs;
	};

	const templates = [o.template, ...(o.baseline ? [o.baseline] : [])];
	const results: Record<number, RunSample[]> = {};
	for (const t of templates) results[t] = await runTemplate(t);

	const metrics: [string, (r: RunSample) => number | null][] = [
		["start_to_qga", (r) => r.first.startToQgaMs],
		["start_to_ip", (r) => r.first.startToIpMs],
		["start_to_agent_ready", (r) => r.first.startToAgentReadyMs],
		["kernel", (r) => r.first.kernelMs],
		["initrd", (r) => r.first.initrdMs],
		["userspace", (r) => r.first.userspaceMs],
		["hard_stop_restart", (r) => r.hardStopRestart.startToQgaMs],
	];
	const summary: Record<number, Record<string, Summary>> = {};
	for (const t of templates) {
		summary[t] = {};
		for (const [name, get] of metrics) {
			const xs = (results[t] ?? [])
				.map(get)
				.filter((x): x is number => x !== null);
			(summary[t] as Record<string, Summary>)[name] = summarize(xs);
		}
	}
	const fmt = (s?: Summary) =>
		s?.median === undefined
			? "-"
			: `${s.median} (p95 ${s.p95}, ${s.min}-${s.max})`;
	process.stdout.write(
		`Boot metrics, ms: median (p95, min-max), ${o.runs} runs each\n${table(
			["metric", ...templates.map((t) => `template ${t}`)],
			metrics.map(([name]) => [
				name,
				...templates.map((t) => fmt(summary[t]?.[name])),
			]),
		)}\n`,
	);
	const target = summary[o.template] ?? {};
	const qga = target.start_to_qga?.median;
	const ready = target.start_to_agent_ready?.median;
	process.stdout.write(
		`targets (spec 13.2): start_to_qga ${qga ?? "-"} ms (<= 8000), start_to_agent_ready ${ready ?? "-"} ms (<= 10000)\n`,
	);

	mkdirSync(o.outDir, { recursive: true });
	const file = join(
		o.outDir,
		`s5-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	writeFileSync(
		file,
		`${JSON.stringify(redact({ options: o, summary, runs: results }, secrets), null, 2)}\n`,
	);
	log(`results: ${file}`);
	return 0;
}
