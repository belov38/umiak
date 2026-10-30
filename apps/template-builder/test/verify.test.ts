import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecResult,
	MachineInfo,
	MachineSize,
	ReadyInfo,
	Smbios,
	SnapshotRef,
} from "@sbx/pve";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.ts";
import type { GuestIo } from "../src/runner.ts";
import {
	checkDoctor,
	checkForkIdentity,
	checkHardRestart,
	checkTools,
	type Facts,
	parseCheckLines,
	scanPatterns,
	TEST_TUNNEL_URL,
	type TunnelRegistrar,
	type VerifyDeps,
	verifyTemplate,
} from "../src/verify.ts";

const UUID_A = "0f8e2c1a-1111-4abc-8def-0123456789ab";
const UUID_F = "7d6c5b4a-2222-4abc-8def-fedcba987654";
const hex = (u: string) => u.replaceAll("-", "");

describe("parseCheckLines", () => {
	it("reads CHECK lines and the TOOLS line", () => {
		const out = [
			"some noise",
			"CHECK os PASS VERSION_ID=26.04",
			"CHECK swap FAIL swapon=[/swap.img file 2G]",
			"CHECK kvm INFO unavailable: no vmx/svm in /proc/cpuinfo",
			"CHECK empty PASS",
			'TOOLS {"node":{"direct":"v26.13.0","login":"v26.13.0"}}',
		].join("\n");
		const r = parseCheckLines(out);
		expect(r.checks).toEqual([
			{ id: "os", status: "PASS", evidence: "VERSION_ID=26.04" },
			{ id: "swap", status: "FAIL", evidence: "swapon=[/swap.img file 2G]" },
			{
				id: "kvm",
				status: "INFO",
				evidence: "unavailable: no vmx/svm in /proc/cpuinfo",
			},
			{ id: "empty", status: "PASS", evidence: "" },
		]);
		expect(r.tools).toEqual({
			node: { direct: "v26.13.0", login: "v26.13.0" },
		});
	});

	it("an unknown status is a FAIL", () => {
		const r = parseCheckLines("CHECK x MAYBE hmm\n");
		expect(r.checks).toEqual([
			{ id: "x", status: "FAIL", evidence: "status MAYBE: hmm" },
		]);
		expect(r.tools).toEqual({});
	});
});

const doctor = (over: Record<string, unknown> = {}) => ({
	versions: { current: "0.3.1", previous: "" },
	units: { "sbx-identity": "active", "sbx-agent": "active" },
	identity: { machine_id: UUID_A },
	tunnel_url: { url: TEST_TUNNEL_URL, source: "smbios" },
	status: { identity: { state: "ready" } },
	...over,
});
const expectDoctor = {
	agentVersion: "0.3.1",
	machineId: UUID_A,
	tunnelUrl: TEST_TUNNEL_URL,
};
const failed = (cs: { id: string; status: string }[]) =>
	cs.filter((c) => c.status === "FAIL").map((c) => c.id);

describe("checkDoctor", () => {
	it("passes a good report", () => {
		const cs = checkDoctor(doctor(), expectDoctor);
		expect(failed(cs)).toEqual([]);
		expect(cs.map((c) => c.id)).toEqual([
			"agent_version",
			"agent_units",
			"agent_identity",
			"agent_tunnel_url",
			"agent_test_aids",
		]);
	});

	it("fails on a wrong version", () => {
		const cs = checkDoctor(
			doctor({ versions: { current: "0.3.0" } }),
			expectDoctor,
		);
		expect(failed(cs)).toEqual(["agent_version"]);
	});

	it("fails when the tunnel URL comes from the config", () => {
		const cs = checkDoctor(
			doctor({ tunnel_url: { url: TEST_TUNNEL_URL, source: "config" } }),
			expectDoctor,
		);
		expect(failed(cs)).toEqual(["agent_tunnel_url"]);
	});

	it("fails on test aids", () => {
		const cs = checkDoctor(doctor({ test_aids: ["failRun"] }), expectDoctor);
		expect(failed(cs)).toEqual(["agent_test_aids"]);
	});

	it("fails on an inactive unit, another machine id or a non-ready identity", () => {
		expect(
			failed(
				checkDoctor(
					doctor({
						units: { "sbx-identity": "active", "sbx-agent": "failed" },
					}),
					expectDoctor,
				),
			),
		).toEqual(["agent_units"]);
		expect(
			failed(
				checkDoctor(doctor({ identity: { machine_id: UUID_F } }), expectDoctor),
			),
		).toEqual(["agent_identity"]);
		expect(
			failed(
				checkDoctor(
					doctor({ status: { identity: { state: "failed" } } }),
					expectDoctor,
				),
			),
		).toEqual(["agent_identity"]);
	});

	it("fails every check on something that is not a report", () => {
		expect(failed(checkDoctor(null, expectDoctor))).toHaveLength(5);
	});
});

describe("checkTools", () => {
	it("passes equal values and a tool missing at build and now", () => {
		const cs = checkTools(
			{
				node: { direct: "v26.13.0", login: "v26.13.0" },
				sbx: { direct: "missing", login: "missing" },
			},
			{ node: "v26.13.0", sbx: null },
		);
		expect(cs).toEqual([
			{ id: "tool_node", status: "PASS", evidence: "v26.13.0" },
			{ id: "tool_sbx", status: "PASS", evidence: "missing (as built)" },
		]);
	});

	it("fails when direct and login differ", () => {
		const cs = checkTools(
			{ go: { direct: "go1.27.1", login: "go1.26.0" } },
			{ go: "go1.27.1" },
		);
		expect(failed(cs)).toEqual(["tool_go"]);
	});

	it("fails on another version, a tool gone and an unknown tool", () => {
		const cs = checkTools(
			{
				node: { direct: "v26.12.0", login: "v26.12.0" },
				jq: { direct: "missing", login: "missing" },
				extra: { direct: "1", login: "1" },
			},
			{ node: "v26.13.0", jq: "jq-1.8.1", rg: "ripgrep 15.1.0" },
		);
		expect(failed(cs)).toEqual([
			"tool_node",
			"tool_jq",
			"tool_rg",
			"tool_extra",
		]);
	});
});

const facts = (over: Partial<Facts> = {}): Facts => ({
	uuid: UUID_A,
	machineId: hex(UUID_A),
	productUuid: UUID_A.toUpperCase(),
	hostname: `sbx-${hex(UUID_A).slice(-12)}`,
	hostKey: "SHA256:aaaa",
	ip: "10.88.0.10",
	...over,
});
const forkFacts = () =>
	facts({
		uuid: UUID_F,
		machineId: hex(UUID_F),
		productUuid: UUID_F,
		hostname: `sbx-${hex(UUID_F).slice(-12)}`,
		hostKey: "SHA256:ffff",
		ip: "10.88.0.11",
	});

describe("checkForkIdentity", () => {
	it("passes a fork with its own identity", () => {
		const cs = checkForkIdentity(facts(), forkFacts());
		expect(failed(cs)).toEqual([]);
		expect(cs.map((c) => c.id)).toEqual([
			"fork_machine_id",
			"fork_hostname",
			"fork_host_keys",
			"fork_ip",
		]);
	});

	it("fails when the host keys are equal", () => {
		const cs = checkForkIdentity(facts(), {
			...forkFacts(),
			hostKey: "SHA256:aaaa",
		});
		expect(failed(cs)).toEqual(["fork_host_keys"]);
	});

	it("fails when a machine id is not its smbios uuid", () => {
		const cs = checkForkIdentity(facts(), {
			...forkFacts(),
			machineId: hex(UUID_A).replace("0f", "aa"),
		});
		expect(failed(cs)).toEqual(["fork_machine_id"]);
	});

	it("fails on equal hostnames and IPs", () => {
		const f = forkFacts();
		const cs = checkForkIdentity(facts(), {
			...f,
			hostname: facts().hostname,
			ip: "10.88.0.10",
		});
		expect(failed(cs)).toEqual(["fork_hostname", "fork_ip"]);
	});
});

describe("checkHardRestart", () => {
	const first = { startToQgaMs: 6000, startToIpMs: 6500 };
	it("allows at most 3 s more than the first boot", () => {
		expect(
			checkHardRestart(first, { startToQgaMs: 9001, startToIpMs: 9500 }).status,
		).toBe("FAIL");
		expect(
			checkHardRestart(first, { startToQgaMs: 9000, startToIpMs: 9500 }).status,
		).toBe("PASS");
	});
});

const PKCS8_ED25519 = generateKeyPairSync("ed25519").privateKey.export({
	type: "pkcs8",
	format: "pem",
}) as string;
const OPENSSH_KEY = [
	"-----BEGIN OPENSSH PRIVATE KEY-----",
	"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
	"QyNTUxOQAAACBmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm",
	"short==",
	"-----END OPENSSH PRIVATE KEY-----",
	"",
].join("\n");

function secretDir(): {
	dir: string;
	files: VerifyDeps["secretFiles"];
} {
	const dir = mkdtempSync(join(tmpdir(), "sbx-verify-"));
	const files = {
		updateSigningKey: join(dir, "ed25519.key"),
		pveToken: join(dir, "pve-token"),
		nodeSshKey: join(dir, "sbx-node_ed25519"),
		devCaKey: join(dir, "ca.key"),
	};
	writeFileSync(files.updateSigningKey, PKCS8_ED25519);
	writeFileSync(files.pveToken, "5b2b6c4e-aaaa-bbbb-cccc-0123456789ab\n");
	writeFileSync(files.nodeSshKey, OPENSSH_KEY);
	return { dir, files };
}

const seedOf = (pem: string) =>
	Buffer.from(
		(createPrivateKey(pem).export({ format: "jwk" }) as { d: string }).d,
		"base64url",
	);

describe("scanPatterns", () => {
	it("takes key bodies, the seed forms, the token and the BS; skips missing files", () => {
		const { files } = secretDir();
		const bs = Buffer.alloc(32, 7);
		const p = scanPatterns(files, bs);
		const seed = seedOf(PKCS8_ED25519);
		const body = PKCS8_ED25519.split("\n").filter(
			(l) => l && !l.startsWith("-----"),
		);
		expect(p.patterns).toEqual(
			expect.arrayContaining([
				...body,
				seed.toString("base64").replace(/=+$/, ""),
				seed.toString("hex"),
				"5b2b6c4e-aaaa-bbbb-cccc-0123456789ab",
				"QyNTUxOQAAACBmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm",
				bs.toString("base64url"),
				bs.toString("hex"),
			]),
		);
		// Generic lines would match every OpenSSH key and PEM file of the guest.
		expect(p.patterns.some((x) => x.startsWith("-----"))).toBe(false);
		expect(p.patterns).not.toContain(
			"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
		);
		expect(p.patterns).not.toContain("short==");
		expect(p.patterns.every((x) => x.length >= 20)).toBe(true);
		expect(new Set(p.patterns).size).toBe(p.patterns.length);
		expect(p.notes).toEqual([`${files.devCaKey}: missing, skipped`]);
	});
});

// --- verifyTemplate with fakes ---

const VERIFY_SH = "#!/usr/bin/env bash\n# verify.sh\nmain\n";

function manifest(): Manifest {
	return {
		buildId: "019a0000-0000-7000-8000-000000000001",
		templateSlug: "linux",
		version: "20261030.1",
		os: "linux",
		status: "building",
		node: "pve",
		storage: "local-lvm",
		pveVmid: 597,
		vmName: "sbx-tpl-linux-20261030-1",
		gitCommit: "abc",
		recipeDigest: "sha256:x",
		base: {
			distro: "ubuntu",
			release: "26.04",
			flavor: "minimal",
			serial: "20261024",
			sha256: "f".repeat(64),
		},
		apt: { snapshot: "20261029T000000Z" },
		kernel: "7.0.0-38-generic",
		systemd: "systemd 259 (259.9)",
		packages: {},
		tools: { node: "v26.13.0", sbx: null },
		agentVersion: "0.3.1",
		defaultTunnelUrl: null,
		hw: {},
		diskLayout: {},
		bootTimeoutS: 180,
		buildMemoryMb: 4096,
		startedAt: "2026-10-30T10:00:00.000Z",
		finishedAt: null,
		durationS: null,
	};
}

interface FakeVm {
	smbios: Smbios;
	size: MachineSize | undefined;
	running: boolean;
	boots: number;
}

/** Machines and their guests: identities follow the smbios, timings come from `bootMs`. */
class World {
	t = 1_000_000;
	log: string[] = [];
	vms = new Map<number, FakeVm>();
	snaps: SnapshotRef[] = [];
	#next = 501;
	/** startToQga per boot: [first, hard restart]; forks use the first. */
	bootMs = [6000, 6500];
	agentActive = true;
	scanCount = 0;
	scans: { name: string; patterns: string[]; at: number }[] = [];
	/** sbx-node: lv.scan on the host. */
	node = {
		call: async <T>(op: string, args?: object): Promise<T> => {
			if (op !== "lv.scan") throw new Error(`unexpected op ${op}`);
			const a = args as { name: string; patterns: string[] };
			this.scans.push({ ...a, at: this.execs.length });
			return { matches: this.scanCount, scannedBytes: 64 * 2 ** 30 } as T;
		},
	};
	execs: { vmid: number; cmd: string[]; input?: string }[] = [];
	hostKeyOf = (vmid: number) => `SHA256:key-${vmid}`;
	onExec?: (vmid: number, cmd: string[]) => void;

	machines: VerifyDeps["machines"] = {
		create: async (o = {}) => this.#create(o, "create"),
		fork: async (snap, o = {}) => {
			this.log.push(`fork ${snap.id}`);
			return this.#create(o, "forked");
		},
		start: async (vmid) => {
			const vm = this.#vm(vmid);
			vm.running = true;
			vm.boots++;
			this.log.push(`start ${vmid}`);
		},
		stop: async (vmid) => {
			this.#vm(vmid).running = false;
			this.log.push(`stop ${vmid}`);
		},
		delete: async (vmid) => {
			this.vms.delete(vmid);
			this.log.push(`delete ${vmid}`);
		},
		waitReady: async (vmid, o = {}) => {
			const vm = this.#vm(vmid);
			const ms = this.bootMs[Math.min(vm.boots - 1, 1)] ?? 0;
			this.t = (o.startedAt ?? this.t) + ms;
			const r: ReadyInfo = {
				pingAt: this.t,
				ipAt: this.t + 300,
				ip: `10.88.0.${vmid - 490}`,
				ifname: "ens18",
			};
			this.t += 300;
			return r;
		},
		snapshot: async (vmid) => {
			const snap: SnapshotRef = {
				kind: "snapshot",
				id: `snap-${vmid}`,
				node: "pve",
				sourceVmid: vmid,
				disks: [],
				hardware: {},
				createdAt: this.t,
			};
			this.snaps.push(snap);
			this.log.push(`snapshot ${vmid}`);
			return snap;
		},
		deleteSnapshot: async (snap) => {
			this.snaps = this.snaps.filter((s) => s.id !== snap.id);
			this.log.push(`delete-snapshot ${snap.id}`);
		},
	};

	#create(
		o: { size?: MachineSize; smbios?: Smbios },
		what: string,
	): MachineInfo {
		const vmid = this.#next++;
		if (!o.smbios) throw new Error("no smbios");
		this.vms.set(vmid, {
			smbios: o.smbios,
			size: o.size,
			running: false,
			boots: 0,
		});
		this.log.push(`${what} ${vmid}`);
		return { vmid, mac: "BC:24:11:00:00:01", node: "pve", disks: [] };
	}

	#vm(vmid: number): FakeVm {
		const vm = this.vms.get(vmid);
		if (!vm) throw new Error(`VM ${vmid} does not exist`);
		return vm;
	}

	io(vmid: number): GuestIo {
		const ok = (stdout: string): ExecResult => ({
			exitCode: 0,
			stdout,
			stderr: "",
		});
		return {
			exec: async (cmd, o) => {
				this.execs.push(
					o?.input === undefined
						? { vmid, cmd }
						: { vmid, cmd, input: o.input },
				);
				this.onExec?.(vmid, cmd);
				const vm = this.#vm(vmid);
				const uuid = vm.smbios.uuid;
				const [c0, c1, c2 = ""] = cmd;
				if (c0 === "systemctl" && c1 === "is-active")
					return ok(this.agentActive ? "active\n" : "activating\n");
				if (c0 === "bash" && c1 === "-s")
					return ok(
						[
							"CHECK os PASS VERSION_ID=26.04",
							"CHECK kvm INFO unavailable: no vmx/svm in /proc/cpuinfo",
							'TOOLS {"node":{"direct":"v26.13.0","login":"v26.13.0"},"sbx":{"direct":"missing","login":"missing"}}',
							"",
						].join("\n"),
					);
				if (c0 === "sbx-agent" && c1 === "doctor")
					return ok(
						JSON.stringify(
							doctor({
								identity: { machine_id: uuid },
								tunnel_url: {
									url: vm.smbios.family?.replace(/^sbxt1:/, ""),
									source: "smbios",
								},
							}),
						),
					);
				if (c0 === "bash" && c2.includes("hello-world"))
					return ok("\nHello from Docker!\nThis message shows ...\n");
				if (c0 === "bash" && c2.includes("grubenv"))
					return ok("CHECK grub_recordfail PASS no recordfail in grubenv\n");
				if (c0 === "bash" && c2.includes("machine-id"))
					return ok(
						[
							`machine_id=${hex(uuid)}`,
							`product_uuid=${uuid.toUpperCase()}`,
							`hostname=sbx-${hex(uuid).slice(-12)}`,
							`host_key=${this.hostKeyOf(vmid)}`,
							"",
						].join("\n"),
					);
				return { exitCode: 127, stdout: "", stderr: `unknown ${cmd[0]}` };
			},
			readFile: async () => Buffer.alloc(0),
			ping: async () => true,
		};
	}
}

function setup(over: Partial<VerifyDeps> = {}) {
	const w = new World();
	const { files } = secretDir();
	const logs: string[] = [];
	const ram: string[] = [];
	const deps: VerifyDeps = {
		machines: w.machines,
		io: (vmid) => w.io(vmid),
		node: w.node,
		ramGuard: {
			reserve: async (vmid, mb) => {
				ram.push(`reserve ${vmid} ${mb}`);
				w.log.push(`reserve ${vmid}`);
			},
			release: (vmid) => {
				ram.push(`release ${vmid}`);
			},
		},
		verifyScript: VERIFY_SH,
		secretFiles: files,
		log: (m) => logs.push(m),
		now: () => w.t,
		sleep: async (ms) => {
			w.t += ms;
		},
		pollMs: 1000,
		randomUUID: (() => {
			const ids = [UUID_A, UUID_F];
			return () => ids.shift() ?? "99999999-9999-4999-8999-999999999999";
		})(),
		...over,
	};
	return { w, deps, logs, ram, files };
}

describe("verifyTemplate", () => {
	it("checks a clone, its hard restart and a fork, then removes everything", async () => {
		const { w, deps, ram, logs } = setup();
		const v = await verifyTemplate(deps, manifest(), {});
		expect(failed(v.checks)).toEqual([]);
		expect(v.ok).toBe(true);
		expect(v.fork).toEqual({ ok: true });
		expect(v.kvm).toEqual({
			available: false,
			reason: "no vmx/svm in /proc/cpuinfo",
		});
		expect(v.boot.first).toEqual({
			startToQgaMs: 6000,
			startToIpMs: 6300,
			startToAgentActiveMs: 6300,
		});
		expect(v.boot.hardRestart.startToQgaMs).toBe(6500);
		const ids = v.checks.map((c) => c.id);
		for (const id of [
			"os",
			"kvm",
			"agent_active",
			"agent_version",
			"agent_tunnel_url",
			"docker",
			"tool_node",
			"tool_sbx",
			"raw_disk_patterns",
			"raw_disk_secrets",
			"tunnel_connected",
			"hard_restart",
			"grub_recordfail",
			"fork_agent_active",
			"fork_machine_id",
			"fork_host_keys",
		])
			expect(ids).toContain(id);
		expect(v.checks.find((c) => c.id === "tunnel_connected")).toMatchObject({
			status: "INFO",
		});
		expect(w.log).toEqual([
			"create 501",
			"reserve 501",
			"start 501",
			"stop 501",
			"start 501",
			"snapshot 501",
			"fork snap-501",
			"forked 502",
			"reserve 502",
			"start 502",
			"delete 502",
			"delete-snapshot snap-501",
			"delete 501",
		]);
		expect(ram).toEqual([
			"reserve 501 2048",
			"reserve 502 2048",
			"release 502",
			"release 501",
		]);
		expect(w.vms.size).toBe(0);
		expect(w.snaps).toHaveLength(0);
		expect(logs.some((l) => l.includes("PASS"))).toBe(true);
	});

	it("gives A and F their own smbios identity with the test tunnel URL", async () => {
		const { w, deps } = setup();
		const sizes: (MachineSize | undefined)[] = [];
		const smbios: Smbios[] = [];
		const create = w.machines.create;
		const fork = w.machines.fork;
		deps.machines = {
			...w.machines,
			create: async (o) => {
				sizes.push(o?.size);
				smbios.push(o?.smbios as Smbios);
				return create(o);
			},
			fork: async (s, o) => {
				sizes.push(o?.size);
				smbios.push(o?.smbios as Smbios);
				return fork(s, o);
			},
		};
		await verifyTemplate(deps, manifest(), {});
		expect(sizes).toEqual([
			{ cores: 2, memoryMb: 2048 },
			{ cores: 2, memoryMb: 2048 },
		]);
		const [a, f] = smbios as [Smbios, Smbios];
		expect(a.uuid).toBe(UUID_A);
		expect(f.uuid).toBe(UUID_F);
		expect(a.family).toBe(`sbxt1:${TEST_TUNNEL_URL}`);
		expect(f.family).toBe(a.family);
		expect(a.serial).toMatch(new RegExp(`^sbx1:${UUID_A}:[A-Za-z0-9_-]{43}$`));
		expect(f.serial).toMatch(new RegExp(`^sbx1:${UUID_F}:[A-Za-z0-9_-]{43}$`));
		expect(f.serial.split(":")[2]).not.toBe(a.serial.split(":")[2]);
	});

	it("passes the expected values through stdin and scans for secrets on the host only", async () => {
		const { w, deps, logs } = setup();
		const v = await verifyTemplate(deps, manifest(), {});
		const run = w.execs.find((e) => e.cmd[0] === "bash" && e.cmd[1] === "-s");
		expect(run?.cmd).toEqual(["bash", "-s"]);
		expect(run?.input).toBe(
			`export MACHINE_ID=${UUID_A}\nexport EXPECT_SUBNET=10.88.0.0/24\n${VERIFY_SH}`,
		);
		// The scans run on the host (sbx-node), on the template and on A, before the hard stop.
		const stopAt = w.execs.findIndex((e) =>
			String(e.cmd[2]).includes("grubenv"),
		);
		expect(w.scans.map((s) => s.name)).toEqual([
			"base-597-disk-0",
			"vm-501-disk-0",
		]);
		for (const s of w.scans) expect(s.at).toBeLessThan(stopAt);
		const patterns = w.scans[0]?.patterns ?? [];
		// Nothing of the scan reaches a guest.
		for (const e of w.execs)
			for (const p of patterns) expect(e.input ?? "").not.toContain(p);
		expect(patterns).toContain("5b2b6c4e-aaaa-bbbb-cccc-0123456789ab");
		const a = w.execs.find((e) => e.vmid === 501);
		expect(a).toBeDefined();
		// The BS of A is a pattern; no pattern appears in argv, logs or evidence.
		const serial = [...patterns].find((p) => p.length === 43);
		expect(serial).toBeDefined();
		const argv = w.execs.map((e) => e.cmd.join(" ")).join("\n");
		const text = `${argv}\n${logs.join("\n")}\n${JSON.stringify(v)}`;
		for (const p of patterns) expect(text).not.toContain(p);
	});

	it("fails on a secret found on the raw disk", async () => {
		const { w, deps } = setup();
		w.scanCount = 2;
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(failed(v.checks)).toEqual(["raw_disk_secrets"]);
	});

	it("fails a slow hard restart", async () => {
		const { w, deps } = setup();
		w.bootMs = [6000, 9001];
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(failed(v.checks)).toEqual(["hard_restart"]);
	});

	it("fails a fork that kept the host keys", async () => {
		const { w, deps } = setup();
		w.hostKeyOf = () => "SHA256:same";
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(v.fork.ok).toBe(false);
		expect(failed(v.checks)).toEqual(["fork_host_keys"]);
	});

	it("fails when the agent does not become active within 60 s", async () => {
		const { w, deps } = setup();
		w.agentActive = false;
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(failed(v.checks)).toContain("agent_active");
		expect(v.boot.first.startToAgentActiveMs).toBeUndefined();
	});

	it("fails a tool that differs from the manifest", async () => {
		const { deps } = setup();
		const m = manifest();
		m.tools = { ...m.tools, node: "v26.12.0" };
		const v = await verifyTemplate(deps, m, {});
		expect(failed(v.checks)).toEqual(["tool_node"]);
	});

	it("keeps the machines with keep", async () => {
		const { w, deps } = setup();
		await verifyTemplate(deps, manifest(), { keep: true });
		expect(w.log.filter((l) => l.startsWith("delete"))).toEqual([]);
		expect(w.vms.size).toBe(2);
	});

	it("removes what it created when a stage throws, and rethrows", async () => {
		const { w, deps, ram } = setup();
		deps.machines = {
			...w.machines,
			snapshot: async () => {
				throw new Error("lvcreate failed");
			},
		};
		await expect(verifyTemplate(deps, manifest(), {})).rejects.toThrow(
			/lvcreate failed/,
		);
		expect(w.vms.size).toBe(0);
		expect(ram).toContain("release 501");
	});

	it("stops between stages on abort and still cleans up", async () => {
		const { w, deps } = setup();
		const ac = new AbortController();
		w.onExec = (_vmid, cmd) => {
			if (cmd[0] === "sbx-agent") ac.abort(new Error("interrupted by SIGINT"));
		};
		await expect(
			verifyTemplate(deps, manifest(), { signal: ac.signal }),
		).rejects.toThrow(/SIGINT/);
		expect(w.log).not.toContain("stop 501");
		expect(w.log.at(-1)).toBe("delete 501");
		expect(w.vms.size).toBe(0);
	});

	it("reports a failed cleanup as a FAIL", async () => {
		const { w, deps } = setup();
		deps.machines = {
			...w.machines,
			deleteSnapshot: async () => {
				throw new Error("snapshot LVs remain");
			},
		};
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(v.checks.at(-1)).toMatchObject({ id: "cleanup", status: "FAIL" });
		expect(w.vms.size).toBe(0);
	});
});

class FakeRegistrar implements TunnelRegistrar {
	calls: string[] = [];
	state: string | null = "connected";
	readonly world: World;
	constructor(world: World) {
		this.world = world;
	}
	async register(machineId: string, bsHashHex: string) {
		this.calls.push(`register ${machineId} ${bsHashHex}`);
		this.world.log.push("register");
	}
	async sessionState(machineId: string) {
		this.calls.push(`state ${machineId}`);
		return this.state;
	}
	async unregister(machineId: string) {
		this.calls.push(`unregister ${machineId}`);
		this.world.log.push("unregister");
	}
}

describe("verifyTemplate with the tunnel connect check", () => {
	const URL = "wss://tunnel.10-0-0-90.sslip.io/v1/connect";

	it("registers the BS hash before A starts and passes on a connected session", async () => {
		const { w, deps } = setup();
		const reg = new FakeRegistrar(w);
		const smbios: Smbios[] = [];
		const create = w.machines.create;
		deps.machines = {
			...w.machines,
			create: async (o) => {
				smbios.push(o?.smbios as Smbios);
				return create(o);
			},
		};
		reg.state = null;
		let polls = 0;
		reg.sessionState = async () => (++polls >= 3 ? "connected 0.3.1 gw" : null);
		const v = await verifyTemplate(deps, manifest(), {
			connect: { url: URL, registrar: reg },
		});
		expect(failed(v.checks)).toEqual([]);
		expect(v.checks.find((c) => c.id === "tunnel_connected")?.status).toBe(
			"PASS",
		);
		expect(smbios[0]?.family).toBe(`sbxt1:${URL}`);
		expect(w.log.indexOf("register")).toBeLessThan(w.log.indexOf("start 501"));
		const bs = Buffer.from(
			String(smbios[0]?.serial.split(":")[2]),
			"base64url",
		);
		expect(reg.calls[0]).toBe(
			`register ${UUID_A} ${createHash("sha256").update(bs).digest("hex")}`,
		);
		expect(w.log.at(-1)).toBe("unregister");
	});

	it("fails when no session connects within 60 s", async () => {
		const { w, deps } = setup();
		const reg = new FakeRegistrar(w);
		reg.state = "disconnected";
		const v = await verifyTemplate(deps, manifest(), {
			connect: { url: URL, registrar: reg },
		});
		expect(failed(v.checks)).toEqual(["tunnel_connected"]);
		expect(reg.calls.at(-1)).toBe(`unregister ${UUID_A}`);
	});

	it("unregisters when a stage fails", async () => {
		const { w, deps } = setup();
		const reg = new FakeRegistrar(w);
		deps.machines = {
			...w.machines,
			start: async () => {
				throw new Error("start failed");
			},
		};
		await expect(
			verifyTemplate(deps, manifest(), {
				connect: { url: URL, registrar: reg },
			}),
		).rejects.toThrow(/start failed/);
		expect(reg.calls.at(-1)).toBe(`unregister ${UUID_A}`);
	});
});

describe("parseCheckLines: a broken TOOLS line", () => {
	it("becomes a FAIL check instead of throwing", () => {
		const r = parseCheckLines('CHECK os PASS 26.04\nTOOLS {"node": \n');
		expect(r.tools).toEqual({});
		expect(r.checks).toEqual([
			{ id: "os", status: "PASS", evidence: "26.04" },
			expect.objectContaining({ id: "verify_sh_tools", status: "FAIL" }),
		]);
	});
});
