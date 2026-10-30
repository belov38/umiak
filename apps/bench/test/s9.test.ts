import { describe, expect, it } from "vitest";
import {
	agentReadiness,
	computerNameFor,
	INFO_CMD,
	runS9Once,
	type S9Deps,
	type S9Run,
	s9Markdown,
	summarizeS9,
} from "../src/s9.ts";
import { type AgentTestsDeps, runAgentTests } from "../src/win-agent-tests.ts";

const run = (n: number): S9Run => ({
	createMs: 1000 * n,
	createToAgentReadyMs: 100_000 + n * 1000,
	bootToAgentReadyMs: 90_000 + n * 1000,
	startToQgaMs: 30_000,
	tunnelConnectedMs: null,
	hardStopRestartMs: 50_000 + n,
	snapshotMs: 2000,
	freezeMs: n === 3 ? null : 800 + n,
	forkMs: 5000,
	forkToAgentReadyMs: 150_000,
	forkBootToAgentReadyMs: 140_000,
	forkTunnelConnectedMs: null,
});

describe("s9 summary", () => {
	it("summarizes runs (median/p95)", () => {
		const s = summarizeS9([run(1), run(2), run(3), run(4)]);
		expect(s.create_to_agent_ready).toMatchObject({
			n: 4,
			median: 102_500,
			p95: 104_000,
			min: 101_000,
			max: 104_000,
		});
		// A missing signal (no tunnel, one run without a freeze time) is left out, not counted as 0.
		expect(s.freeze_ms).toMatchObject({ n: 3, median: 802, min: 801 });
		expect(s.tunnel_connected).toEqual({ n: 0 });
		const md = s9Markdown(s, 4);
		expect(md).toContain("| metric | n | median | p95 | min | max |");
		expect(md).toContain(
			"| create_to_agent_ready | 4 | 102500 | 104000 | 101000 | 104000 |",
		);
		expect(md).toContain("| tunnel_connected | 0 | - | - | - | - |");
	});
});

describe("agentReadiness", () => {
	const id = "0a1b2c3d-1111-2222-3333-444455556666";
	const info = (o: Record<string, unknown>) => ({
		machine_id: id,
		hostname: "SBX444455556666",
		readiness: [
			{ name: "identity", state: "ready" },
			{ name: "claim", state: "pending" },
		],
		...o,
	});

	it("needs the machine id and a ready identity", () => {
		expect(agentReadiness(info({}), { machineId: id }).ready).toBe(true);
		expect(
			agentReadiness(info({ machine_id: "other" }), { machineId: id }).ready,
		).toBe(false);
		expect(
			agentReadiness(
				info({ readiness: [{ name: "identity", state: "pending" }] }),
				{ machineId: id },
			).ready,
		).toBe(false);
		// protojson spelling
		expect(
			agentReadiness(
				{
					machineId: id.toUpperCase(),
					readiness: [{ name: "identity", state: "PHASE_STATE_READY" }],
				},
				{ machineId: id },
			).ready,
		).toBe(true);
	});

	it("waits for the new computer name of a fork", () => {
		const want = { machineId: id, hostname: computerNameFor(id) };
		expect(want.hostname).toBe("SBX444455556666");
		expect(agentReadiness(info({}), want).ready).toBe(true);
		expect(
			agentReadiness(info({ hostname: "SBXAAAAAAAAAAAA" }), want).ready,
		).toBe(false);
	});
});

interface Call {
	op: string;
	vmid?: number;
}

/** A Machines fake that records the order of power operations and answers Info like the agent. */
function fakeDeps(opts: { failFork?: boolean } = {}) {
	const calls: Call[] = [];
	const ids: string[] = [];
	const uuidOf = new Map<number, string>();
	const running = new Set<number>();
	let next = 500;
	let renamed = false;
	let clock = 0;
	const rec = (op: string, vmid?: number) =>
		calls.push(vmid === undefined ? { op } : { op, vmid });
	const machines = {
		async create(o: { smbios?: { uuid: string } }) {
			const vmid = next++;
			uuidOf.set(vmid, o.smbios?.uuid ?? "");
			rec("create", vmid);
			return { vmid, mac: "", node: "pve", disks: [] };
		},
		async fork(_s: unknown, o: { smbios?: { uuid: string } }) {
			if (opts.failFork) throw new Error("fork boom");
			const vmid = next++;
			uuidOf.set(vmid, o.smbios?.uuid ?? "");
			rec("fork", vmid);
			return { vmid, mac: "", node: "pve", disks: [] };
		},
		async snapshot(vmid: number) {
			rec("snapshot", vmid);
			return {
				kind: "snapshot",
				id: "snap1",
				node: "pve",
				sourceVmid: vmid,
				disks: [],
				hardware: {},
				createdAt: 0,
				freezeMs: 750,
			} as const;
		},
		async deleteSnapshot() {
			rec("deleteSnapshot");
		},
		async start(vmid: number) {
			if (running.size > 0) throw new Error("two VMs running at once");
			running.add(vmid);
			rec("start", vmid);
		},
		async stop(vmid: number) {
			running.delete(vmid);
			rec("stop", vmid);
		},
		async shutdown(vmid: number) {
			running.delete(vmid);
			rec("shutdown", vmid);
		},
		async delete(vmid: number) {
			running.delete(vmid);
			rec("delete", vmid);
		},
		qga: {
			async ping() {
				return true;
			},
			async exec(vmid: number, cmd: string[]) {
				expect(cmd).toEqual(INFO_CMD);
				const id = uuidOf.get(vmid) ?? "";
				// A fork reports the old name on its first answer, the new one after the rename.
				const forkVm = vmid === 501;
				const hostname =
					forkVm && !renamed ? "SBXOLD" : `SBX${id.slice(-12).toUpperCase()}`;
				if (forkVm) renamed = true;
				return {
					exitCode: 0,
					stderr: "",
					stdout: JSON.stringify({
						machine_id: id,
						hostname,
						readiness: [{ name: "identity", state: "ready" }],
					}),
				};
			},
		},
	};
	const deps: S9Deps = {
		machines: machines as unknown as S9Deps["machines"],
		ram: {
			async reserve(vmid) {
				rec("reserve", vmid);
			},
			release(vmid) {
				rec("release", vmid);
			},
		},
		keep: false,
		now: () => {
			clock += 100;
			return clock;
		},
		sleep: async () => {},
		pollMs: 1,
		randomUUID: () => {
			const id = `00000000-0000-4000-8000-${String(ids.length + 1).padStart(12, "0")}`;
			ids.push(id);
			return id;
		},
		log: () => {},
	};
	return { deps, calls };
}

describe("runS9Once", () => {
	it("keeps one Windows VM at a time and deletes everything", async () => {
		const { deps, calls } = fakeDeps();
		const r = await runS9Once(deps);
		const ops = calls.map((c) => c.op + (c.vmid ? `:${c.vmid}` : ""));
		expect(ops).toEqual([
			"create:500",
			"reserve:500",
			"start:500",
			"stop:500",
			"start:500",
			"snapshot:500",
			"shutdown:500",
			"release:500",
			"fork:501",
			"reserve:501",
			"start:501",
			"delete:501",
			"delete:500",
			"deleteSnapshot",
			"release:501",
		]);
		expect(r.freezeMs).toBe(750);
		expect(r.tunnelConnectedMs).toBeNull();
		expect(r.forkToAgentReadyMs).toBeGreaterThan(0);
	});

	it("deletes what it made when the fork fails and reports the failure", async () => {
		const { deps, calls } = fakeDeps({ failFork: true });
		await expect(runS9Once(deps)).rejects.toThrow(/fork boom/);
		const ops = calls.map((c) => c.op + (c.vmid ? `:${c.vmid}` : ""));
		expect(ops.slice(-2)).toEqual(["delete:500", "deleteSnapshot"]);
	});

	it("keeps the VMs with keep", async () => {
		const { deps, calls } = fakeDeps();
		await runS9Once({ ...deps, keep: true });
		expect(calls.some((c) => c.op === "delete")).toBe(false);
	});

	it("registers both identities with the tunnel and waits for the session", async () => {
		const { deps } = fakeDeps();
		const log: string[] = [];
		const sessions = new Map<string, number>();
		const out = await runS9Once({
			...deps,
			connect: {
				url: "wss://gw.example/v1/connect",
				registrar: {
					async register(id, hash) {
						expect(hash).toMatch(/^[0-9a-f]{64}$/);
						log.push(`register ${id}`);
					},
					async sessionState(id) {
						// connected on the second poll
						const n = (sessions.get(id) ?? 0) + 1;
						sessions.set(id, n);
						return n >= 2 ? "connected" : null;
					},
					async unregister(id) {
						log.push(`unregister ${id}`);
					},
				},
			},
		});
		expect(log.filter((l) => l.startsWith("register"))).toHaveLength(2);
		expect(log.filter((l) => l.startsWith("unregister"))).toHaveLength(2);
		expect(out.tunnelConnectedMs).not.toBeNull();
		expect(out.forkTunnelConnectedMs).not.toBeNull();
		expect(out.createToAgentReadyMs).toBeGreaterThanOrEqual(
			out.tunnelConnectedMs as number,
		);
	});
});

const INFO_OK = (id: string) =>
	JSON.stringify({
		machine_id: id,
		hostname: "SBXTEST",
		readiness: [{ name: "identity", state: "ready" }],
	});

/** Machines fake for agent-tests: records calls; test binaries exit with the given codes. */
function fakeTestsRun(
	opts: { exitCodes?: Record<string, number>; copyFails?: boolean } = {},
) {
	const calls: string[] = [];
	const execs: string[][] = [];
	let uuid = "";
	let onCd = false;
	const machines = {
		async create(o: { smbios?: { uuid: string } }) {
			uuid = o.smbios?.uuid ?? "";
			calls.push("create:500");
			return { vmid: 500, mac: "", node: "pve", disks: [] };
		},
		async start(vmid: number) {
			calls.push(`start:${vmid}`);
			expect(onCd).toBe(true);
		},
		async delete(vmid: number) {
			calls.push(`delete:${vmid}`);
		},
		qga: {
			async ping() {
				return true;
			},
			async exec(_vmid: number, cmd: string[]) {
				execs.push(cmd);
				if (cmd[0] === "powershell") {
					if (opts.copyFails)
						return { exitCode: 1, stdout: "", stderr: "no volume" };
					return {
						exitCode: 0,
						stdout: "internal_a.test.exe\r\ninternal_b.test.exe\r\n",
						stderr: "",
					};
				}
				if (cmd[0] === "C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe")
					return { exitCode: 0, stdout: INFO_OK(uuid), stderr: "" };
				const code = opts.exitCodes?.[cmd[0] ?? ""] ?? 0;
				return {
					exitCode: code,
					stdout: `=== RUN ${cmd[0]}\n${code === 0 ? "PASS" : "FAIL"}\n`,
					stderr: "",
				};
			},
		},
	};
	const iso = {
		made: [] as { names: string[]; label: string; sizes: number[] }[],
		make(files: Map<string, Buffer>, path: string, label: string) {
			calls.push("make");
			expect(path).toMatch(/sbx-build-agenttests-\d{14}\.iso$/);
			this.made.push({
				names: [...files.keys()],
				label,
				sizes: [...files.values()].map((b) => b.length),
			});
		},
		async upload(name: string) {
			calls.push(`upload:${name}`);
			expect(name).toMatch(/^sbx-build-[a-z0-9-]{1,64}\.iso$/);
		},
		async remove(name: string) {
			calls.push(`remove:${name.replace(/\d{14}/, "<ts>")}`);
		},
		async attach(vmid: number, name: string) {
			calls.push(`attach:${vmid}:${name.replace(/\d{14}/, "<ts>")}`);
			onCd = true;
		},
	};
	let printed = "";
	const deps = {
		machines: machines as unknown as AgentTestsDeps["machines"],
		ram: {
			async reserve(vmid: number) {
				calls.push(`reserve:${vmid}`);
			},
			release(vmid: number) {
				calls.push(`release:${vmid}`);
			},
		},
		iso,
		files: {
			list: () => ["internal_a.test.exe", "internal_b.test.exe", "notes.txt"],
			read: (p: string) =>
				p.endsWith("internal_a.test.exe")
					? Buffer.alloc(70_000, 7)
					: Buffer.from("MZ"),
		},
		out: (s: string) => {
			printed += s;
		},
		log: () => {},
		sleep: async () => {},
		pollMs: 1,
	} satisfies AgentTestsDeps;
	return { deps, calls, execs, iso, printed: () => printed };
}

const A = "C:\\sbx-tests\\internal_a.test.exe";
const B = "C:\\sbx-tests\\internal_b.test.exe";
const opts = { template: 598, dir: "/tmp/x", keep: false, ramCapMb: 8192 };

describe("agent-tests", () => {
	it("runs every binary from the ISO clone as SYSTEM, fails on a non-zero exit and cleans up", async () => {
		const t = fakeTestsRun({ exitCodes: { [B]: 1 } });
		const code = await runAgentTests(t.deps, { ...opts, run: "TestFoo" });
		expect(code).toBe(1);
		// The ISO holds only the test binaries, whole (no chunking), under the SBXTESTS label.
		expect(t.iso.made).toEqual([
			{
				names: ["internal_a.test.exe", "internal_b.test.exe"],
				label: "SBXTESTS",
				sizes: [70_000, 2],
			},
		]);
		expect(t.calls).toEqual([
			"make",
			expect.stringMatching(/^upload:sbx-build-agenttests-\d{14}\.iso$/),
			"create:500",
			"attach:500:sbx-build-agenttests-<ts>.iso",
			"reserve:500",
			"start:500",
			"delete:500",
			"remove:sbx-build-agenttests-<ts>.iso",
			"release:500",
		]);
		const runs = t.execs.filter((c) => c[0]?.endsWith(".test.exe"));
		expect(runs).toEqual([
			[A, "-test.v", "-test.timeout", "10m", "-test.run", "TestFoo"],
			[B, "-test.v", "-test.timeout", "10m", "-test.run", "TestFoo"],
		]);
		expect(t.printed()).toContain(`=== RUN ${A}`);
		expect(t.printed()).toMatch(/internal_b\.test\.exe\s+FAIL \(exit 1\)/);
	});

	it("passes when every binary exits 0", async () => {
		const t = fakeTestsRun();
		expect(await runAgentTests(t.deps, opts)).toBe(0);
		const runs = t.execs.filter((c) => c[0]?.endsWith(".test.exe"));
		expect(runs[0]).toEqual([A, "-test.v", "-test.timeout", "10m"]);
	});

	it("deletes the clone and the ISO when the copy fails", async () => {
		const t = fakeTestsRun({ copyFails: true });
		let clock = 0;
		await expect(
			runAgentTests(
				{
					...t.deps,
					now: () => {
						clock += 30_000;
						return clock;
					},
				},
				opts,
			),
		).rejects.toThrow(/copy from the SBXTESTS CD failed/);
		expect(t.calls).toContain("delete:500");
		expect(t.calls.some((c) => c.startsWith("remove:"))).toBe(true);
	});

	it("keeps the clone and the ISO with keep", async () => {
		const t = fakeTestsRun();
		await runAgentTests(t.deps, { ...opts, keep: true });
		expect(t.calls.some((c) => c.startsWith("delete:"))).toBe(false);
		expect(t.calls.some((c) => c.startsWith("remove:"))).toBe(false);
	});

	it("refuses a directory without test binaries", async () => {
		const t = fakeTestsRun();
		await expect(
			runAgentTests(
				{
					...t.deps,
					files: { list: () => ["x.txt"], read: () => Buffer.alloc(0) },
				},
				opts,
			),
		).rejects.toThrow(/no \*\.test\.exe/);
		expect(t.calls).toEqual([]);
	});
});
