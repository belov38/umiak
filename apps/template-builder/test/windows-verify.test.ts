import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ExecResult,
	FreezeBudgetExceededError,
	type MachineInfo,
	type MachineSize,
	type ReadyInfo,
	type Smbios,
	type SnapshotRef,
} from "@sbx/pve";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/manifest.ts";
import type { GuestIo } from "../src/runner.ts";
import {
	TEST_TUNNEL_URL,
	type TunnelRegistrar,
	type VerifyDeps,
	verifyTemplate,
} from "../src/verify.ts";
import {
	AGENT_EXE,
	agentCallCmd,
	agentDoctorCmd,
	agentExecCmd,
	agentLogsCmd,
	agentSelftestCmd,
	checkLicense,
	checkShellContract,
	checkWindowsDoctor,
	checkWindowsFork,
	computerNameFor,
	type ForkProbe,
	GUEST_SCRIPT,
	PWSH_EXE,
	parseWindowsOutput,
	SHELL_CASES,
	verifyWindows,
	type WinSide,
} from "../src/windows/verify.ts";

const UUID_A = "0f8e2c1a-1111-4abc-8def-0123456789ab";
const UUID_B = "7d6c5b4a-2222-4abc-8def-fedcba987654";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const failed = (cs: { id: string; status: string }[]) =>
	cs.filter((c) => c.status === "FAIL").map((c) => c.id);

const VERIFY_PS1 = resolve(
	import.meta.dirname,
	"../../../infra/templates/windows/verify.ps1",
);

describe("parseWindowsOutput", () => {
	it("parses CHECK lines with CRLF, the TOOLS, LICENSE and FACTS lines", () => {
		const out = [
			"noise",
			"CHECK os PASS EditionID=Professional (want Professional)",
			"CHECK listen_tcp FAIL unexpected: 0.0.0.0:5040(svchost)",
			"CHECK trim INFO warning: not supported",
			'TOOLS {"node":{"direct":"v26.13.0","login":"v26.13.0"}}',
			'LICENSE {"status":"Licensed","channel":"RETAIL"}',
			'FACTS {"computerName":"SBX0123456789AB"}',
			"",
		].join("\r\n");
		const r = parseWindowsOutput(out);
		expect(r.checks).toEqual([
			{
				id: "os",
				status: "PASS",
				evidence: "EditionID=Professional (want Professional)",
			},
			{
				id: "listen_tcp",
				status: "FAIL",
				evidence: "unexpected: 0.0.0.0:5040(svchost)",
			},
			{ id: "trim", status: "INFO", evidence: "warning: not supported" },
		]);
		expect(r.tools).toEqual({
			node: { direct: "v26.13.0", login: "v26.13.0" },
		});
		expect(r.license).toEqual({ status: "Licensed", channel: "RETAIL" });
		expect(r.facts).toEqual({ computerName: "SBX0123456789AB" });
	});

	it("a broken LICENSE or FACTS line becomes a FAIL check", () => {
		const r = parseWindowsOutput("LICENSE {nope\r\nFACTS [\r\n");
		expect(failed(r.checks)).toEqual([
			"verify_ps1_license",
			"verify_ps1_facts",
		]);
		expect(r.license).toBeUndefined();
		expect(r.facts).toBeUndefined();
	});
});

describe("agent CLI argv helpers", () => {
	it("build every sbx-agent command line of the contract", () => {
		expect(agentDoctorCmd()).toEqual([AGENT_EXE, "doctor", "--json"]);
		expect(agentLogsCmd(50)).toEqual([AGENT_EXE, "logs", "-n", "50"]);
		expect(agentSelftestCmd()).toEqual([AGENT_EXE, "selftest", "--pty"]);
		expect(agentCallCmd("a.B/C")).toEqual([AGENT_EXE, "call", "a.B/C", "-"]);
		expect(agentExecCmd({ user: "user", argv: ["npm", "-v"] })).toEqual([
			AGENT_EXE,
			"exec",
			"--user",
			"user",
			"--",
			"npm",
			"-v",
		]);
		expect(agentExecCmd({ shell: "exit 7" })).toEqual([
			AGENT_EXE,
			"exec",
			"--shell",
			"exit 7",
		]);
	});
});

describe("checkShellContract", () => {
	const good = () =>
		SHELL_CASES.map((c) => ({
			id: c.id,
			exitCode: c.want,
			stdout: c.stdout ? `${c.stdout}\r\n` : "",
		}));

	it("passes the codes of spec 12.6", () => {
		expect(SHELL_CASES.map((c) => [c.script, c.want])).toEqual([
			["exit 7", 7],
			["cmd /c exit 3", 3],
			["Get-Item C:\\nope", 1],
			["Write-Output ok", 0],
		]);
		expect(failed(checkShellContract(good()))).toEqual([]);
	});

	it("pwsh exit-code contract assertions fail on wrong codes", () => {
		const rs = good();
		rs[0] = { id: "shell_exit_7", exitCode: 1, stdout: "" };
		rs[1] = { id: "shell_native_exit", exitCode: 1, stdout: "" };
		rs[2] = { id: "shell_cmdlet_error", exitCode: 0, stdout: "" };
		rs[3] = { id: "shell_ok", exitCode: 0, stdout: "" };
		const cs = checkShellContract(rs);
		expect(failed(cs)).toEqual([
			"shell_exit_7",
			"shell_native_exit",
			"shell_cmdlet_error",
			"shell_ok",
		]);
		expect(cs[0]?.evidence).toMatch(/exit 1, want 7/);
	});

	it("a case that did not run fails", () => {
		expect(failed(checkShellContract(good().slice(1)))).toEqual([
			"shell_exit_7",
		]);
	});
});

const side = (uuid: string, over: Partial<WinSide> = {}): WinSide => ({
	uuid,
	computerName: computerNameFor(uuid),
	machineGuid: uuid,
	hostKeys: [`SHA256:key-${uuid}`],
	lsaHash: "lsa-hash-1",
	info: {
		machineId: uuid,
		hostname: computerNameFor(uuid),
		claimed: uuid === UUID_A,
	},
	...over,
});
const probe = (over: Partial<ForkProbe> = {}): ForkProbe => ({
	marker: "marker-1",
	dpapi: "dpapi-1",
	bootsSince: 2,
	identityResetLogged: true,
	...over,
});
const EXPECT_FORK = { marker: "marker-1", dpapi: "dpapi-1" };

describe("checkWindowsFork", () => {
	it("computer names are SBX + the last 12 hex digits upper-case", () => {
		expect(computerNameFor(UUID_A)).toBe("SBX0123456789AB");
		expect(computerNameFor(UUID_B)).toBe("SBXFEDCBA987654");
	});

	it("passes a fork with a new identity that kept the data and the password", () => {
		const cs = checkWindowsFork(
			side(UUID_A),
			side(UUID_B),
			probe(),
			EXPECT_FORK,
		);
		expect(failed(cs)).toEqual([]);
		expect(cs.map((c) => c.id)).toEqual([
			"fork_name",
			"fork_machine_guid",
			"fork_agent_machine_id",
			"fork_host_keys",
			"fork_marker",
			"fork_dpapi",
			"fork_password_kept",
			"fork_one_reboot",
			"fork_identity_reset",
			"fork_agent_state",
		]);
	});

	it("fork check requires a new name and the marker", () => {
		const cs = checkWindowsFork(
			side(UUID_A),
			side(UUID_B, {
				computerName: computerNameFor(UUID_A),
				info: { machineId: UUID_B, hostname: "x", claimed: false },
			}),
			probe({ marker: null }),
			EXPECT_FORK,
		);
		expect(failed(cs)).toEqual(["fork_name", "fork_marker"]);
	});

	it("fails on a kept MachineGuid, shared host keys, a changed password, a lost DPAPI secret", () => {
		const cs = checkWindowsFork(
			side(UUID_A),
			side(UUID_B, {
				machineGuid: UUID_A,
				hostKeys: [`SHA256:key-${UUID_A}`],
				lsaHash: "lsa-hash-2",
			}),
			probe({ dpapi: null }),
			EXPECT_FORK,
		);
		expect(failed(cs)).toEqual([
			"fork_machine_guid",
			"fork_host_keys",
			"fork_dpapi",
			"fork_password_kept",
		]);
	});

	it("fails without the extra reboot, the identity.reset event or with the claim kept", () => {
		const cs = checkWindowsFork(
			side(UUID_A),
			side(UUID_B, {
				info: {
					machineId: UUID_B,
					hostname: computerNameFor(UUID_B),
					claimed: true,
				},
			}),
			probe({ bootsSince: 1, identityResetLogged: false }),
			EXPECT_FORK,
		);
		expect(failed(cs)).toEqual([
			"fork_one_reboot",
			"fork_identity_reset",
			"fork_agent_state",
		]);
	});
});

const doctor = (over: Record<string, unknown> = {}) => ({
	versions: { current: "0.5.0", previous: "" },
	units: { "sbx-agent": "running" },
	identity: { machine_id: UUID_A },
	tunnel_url: { url: TEST_TUNNEL_URL, source: "smbios" },
	status: { identity: { state: "ready" } },
	...over,
});
const EXPECT_DOCTOR = {
	agentVersion: "0.5.0",
	machineId: UUID_A,
	tunnelUrl: TEST_TUNNEL_URL,
};

describe("checkWindowsDoctor", () => {
	it("passes a good report", () => {
		expect(failed(checkWindowsDoctor(doctor(), EXPECT_DOCTOR))).toEqual([]);
	});

	it("takes the identity state from the readiness phases too", () => {
		const cs = checkWindowsDoctor(
			doctor({
				status: null,
				readiness: { phases: [{ name: "identity", state: "ready" }] },
			}),
			EXPECT_DOCTOR,
		);
		expect(failed(cs)).toEqual([]);
	});

	it("fails on another version, machine id, tunnel source or a stopped service", () => {
		const cs = checkWindowsDoctor(
			doctor({
				versions: { current: "0.4.0" },
				identity: { machine_id: UUID_B },
				tunnel_url: { url: TEST_TUNNEL_URL, source: "config" },
				units: { "sbx-agent": "stopped" },
				test_aids: ["failRun"],
			}),
			EXPECT_DOCTOR,
		);
		expect(failed(cs)).toEqual([
			"agent_version",
			"agent_identity",
			"agent_tunnel_url",
			"agent_service_doctor",
			"agent_test_aids",
		]);
	});

	it("a service state the report does not carry is INFO", () => {
		const cs = checkWindowsDoctor(doctor({ units: {} }), EXPECT_DOCTOR);
		expect(cs.find((c) => c.id === "agent_service_doctor")?.status).toBe(
			"INFO",
		);
	});
});

const NOW = Date.parse("2026-10-31T12:00:00Z");

function manifest(over: Partial<Manifest> = {}): Manifest {
	return {
		buildId: "0199f0aa-0000-7000-8000-000000000001",
		templateSlug: "windows",
		version: "20261031.1",
		os: "windows",
		status: "building",
		node: "pve",
		storage: "local-lvm",
		pveVmid: 598,
		vmName: "sbx-tpl-windows-20261031-1",
		gitCommit: "abc",
		recipeDigest: "d",
		windows: {
			edition: "Windows 11 Pro",
			editionId: "Professional",
			build: "26300",
			ubr: 9457,
			displayVersion: "26H1",
			family: "client",
			isoFile: "win.iso",
			isoSha256: "0".repeat(64),
			virtioWinVersion: "0.1.271",
			openssh: { source: "inbox", version: "9.8.3.1" },
			appxRemoved: [],
			options: { vsBuildtools: false },
		},
		license: {
			status: null,
			channel: "retail",
			daysRemaining: null,
			expiresAt: null,
		},
		kernel: null,
		systemd: null,
		packages: {},
		tools: {
			pwsh: "PowerShell 7.6.9",
			node: "v26.13.0",
			npm: "11.6.2",
		},
		agentVersion: "0.5.0",
		defaultTunnelUrl: null,
		hw: {},
		diskLayout: {},
		bootTimeoutS: 1200,
		buildMemoryMb: 4096,
		startedAt: "2026-10-31T10:00:00.000Z",
		finishedAt: null,
		durationS: null,
		...over,
	};
}

describe("checkLicense", () => {
	it("retail: the edition must match, the activation state is INFO", () => {
		const r = checkLicense(
			{
				status: "Notification",
				description: "Windows(R) Operating System, RETAIL channel",
				graceMinutes: 0,
				evaluationEnd: null,
				editionId: "Professional",
			},
			manifest(),
			NOW,
		);
		expect(r.pending).toBe(false);
		expect(r.checks.map((c) => [c.id, c.status])).toEqual([
			["license_edition", "PASS"],
			["license_status", "INFO"],
		]);
		expect(r.license).toEqual({
			status: "Notification",
			channel: "retail",
			daysRemaining: null,
			expiresAt: null,
		});
		expect(
			failed(
				checkLicense(
					{ status: "Licensed", editionId: "Enterprise" },
					manifest(),
					NOW,
				).checks,
			),
		).toEqual(["license_edition"]);
	});

	it("evaluation: waits for activation, then warns under 30 days and fails under 7", () => {
		const m = manifest({
			license: {
				status: null,
				channel: "evaluation",
				daysRemaining: null,
				expiresAt: null,
			},
		});
		const lic = (status: string, days: number) => ({
			status,
			editionId: "Professional",
			evaluationEnd: new Date(NOW + days * 86_400_000).toISOString(),
		});
		expect(checkLicense(lic("OOBGrace", 90), m, NOW).pending).toBe(true);
		const ok = checkLicense(lic("Licensed", 90), m, NOW);
		expect(ok.pending).toBe(false);
		expect(failed(ok.checks)).toEqual([]);
		expect(ok.license.daysRemaining).toBe(90);
		expect(ok.license.expiresAt).toBe(
			new Date(NOW + 90 * 86_400_000).toISOString(),
		);
		expect(
			checkLicense(lic("Licensed", 20), m, NOW).checks.find(
				(c) => c.id === "license_days",
			)?.status,
		).toBe("INFO");
		expect(failed(checkLicense(lic("Licensed", 5), m, NOW).checks)).toEqual([
			"license_days",
		]);
	});
});

// The world: machines, their disks (files the guest checks look at) and the agent on each.

interface Disk {
	/** Machine id the agent applied (identity.json). */
	identity: string;
	password: string;
	files: Map<string, string>;
	claimed: boolean;
}

interface FakeVm {
	smbios: Smbios;
	size: MachineSize | undefined;
	running: boolean;
	disk: Disk;
	/** Boots since the VM was created. */
	boots: number;
	/** Info answers left before the agent is ready in this boot. */
	notReady: number;
	secretEnv: string | undefined;
	forked: boolean;
	/** Info answers of a fork that still report the old computer name. */
	staleHostname: number;
}

const SECRET_FILE = "C:\\ProgramData\\sbx\\secrets\\files\\sbx-verify";
const DPAPI = "C:\\Users\\user\\sbx-verify-dpapi.txt";

const cloneDisk = (d: Disk): Disk => ({ ...d, files: new Map(d.files) });

class WinWorld {
	t = NOW;
	log: string[] = [];
	vms = new Map<number, FakeVm>();
	snaps = new Map<string, Disk>();
	execs: { vmid: number; cmd: string[]; input?: string }[] = [];
	written = new Map<string, string>();
	#next = 501;
	/** Boot (QGA) time of every start. */
	bootMs = 40_000;
	/** Info answers before the agent is ready on a normal boot. */
	readyPolls = 2;
	/** Exit code override per shell script. */
	shellCodes: Record<string, number> = {};
	/** The agent never becomes ready. */
	agentDead = false;
	/** The fork's agent never sees a new identity. */
	forkKeepsName = false;
	/** Info answers of a fork's first boot that carry the machine id but the old computer name. */
	forkStaleHostnames = 0;
	/** Same for A's first boot: setup's interim name before the agent's rename reboot (R16). */
	firstStaleHostnames = 0;
	frozen = false;
	/** Outcomes of the next quiesced snapshots on a slow host (then a normal one). */
	snapshotOutcomes: ("budget" | "autoThawed")[] = [];
	onExec?: (vmid: number, cmd: string[]) => void;

	machines: VerifyDeps["machines"] = {
		create: async (o = {}) =>
			this.#create(o, "create", {
				identity: "",
				password: "pw-template",
				files: new Map(),
				claimed: false,
			}),
		fork: async (snap, o = {}) => {
			const d = this.snaps.get(snap.id);
			if (!d) throw new Error(`no snapshot ${snap.id}`);
			const info = this.#create(o, "fork", cloneDisk(d));
			const vm = this.vms.get(info.vmid) as FakeVm;
			vm.forked = true;
			vm.staleHostname = this.forkStaleHostnames;
			return info;
		},
		start: async (vmid) => {
			const vm = this.#vm(vmid);
			if (vm.running) throw new Error(`VM ${vmid} is running`);
			const running = [...this.vms.values()].filter((v) => v.running).length;
			if (running > 0) throw new Error("two Windows VMs at once");
			vm.running = true;
			vm.boots++;
			// early: the identity, the secrets directory.
			const uuid = vm.smbios.uuid;
			const changed = vm.disk.identity !== uuid;
			if (changed && !(vm.forked && this.forkKeepsName)) {
				if (vm.disk.identity === "") vm.disk.password = `pw-${uuid}`;
				else vm.boots++; // the rename reboot
				vm.disk.identity = uuid;
				vm.disk.claimed = false;
			}
			for (const k of [...vm.disk.files.keys()])
				if (k.startsWith("C:\\ProgramData\\sbx\\secrets\\"))
					vm.disk.files.delete(k);
			vm.secretEnv = undefined;
			vm.notReady = changed ? this.readyPolls + 3 : this.readyPolls;
			this.log.push(`start ${vmid}`);
		},
		stop: async (vmid) => {
			this.#vm(vmid).running = false;
			this.log.push(`stop ${vmid}`);
		},
		shutdown: async (vmid, timeoutS) => {
			this.#vm(vmid).running = false;
			this.log.push(`shutdown ${vmid} ${timeoutS}`);
		},
		delete: async (vmid) => {
			this.vms.delete(vmid);
			this.log.push(`delete ${vmid}`);
		},
		waitReady: async (vmid, o = {}) => {
			this.#vm(vmid);
			this.t = (o.startedAt ?? this.t) + this.bootMs;
			const r: ReadyInfo = {
				pingAt: this.t,
				ipAt: this.t + 500,
				ip: `10.88.0.${vmid - 490}`,
				ifname: "Ethernet",
			};
			this.t += 500;
			return r;
		},
		snapshot: async (vmid, o = {}) => {
			const vm = this.#vm(vmid);
			if (!vm.running) throw new Error("snapshot of a stopped VM");
			const crash = o.crashConsistent === true;
			const outcome = crash ? undefined : this.snapshotOutcomes.shift();
			this.log.push(`snapshot ${vmid}${crash ? " crash" : ""}`);
			if (outcome === "budget")
				throw new FreezeBudgetExceededError(
					"freeze took 14200 ms (budget 10000 ms); snapshot discarded",
					14_200,
				);
			const id = `snap${vmid}`;
			this.snaps.set(id, cloneDisk(vm.disk));
			const s: SnapshotRef = {
				kind: "snapshot",
				id,
				node: "pve",
				sourceVmid: vmid,
				disks: [],
				hardware: {},
				createdAt: this.t,
				...(crash ? {} : { freezeMs: outcome ? 12_300 : 1500 }),
				...(outcome === "autoThawed" ? { autoThawed: true } : {}),
			};
			return s;
		},
		deleteSnapshot: async (snap) => {
			this.snaps.delete(snap.id);
			this.log.push(`delete-snapshot ${snap.id}`);
		},
	};

	windows: NonNullable<VerifyDeps["windows"]> = {
		fsfreezeFreeze: async () => {
			this.frozen = true;
			this.t += 800;
		},
		fsfreezeThaw: async () => {
			this.frozen = false;
		},
		fsfreezeStatus: async () => (this.frozen ? "frozen" : "thawed"),
		writeFile: async (vmid, path, data) => {
			this.#vm(vmid).disk.files.set(path, data.toString("utf8"));
			this.written.set(`${vmid} ${path}`, data.toString("utf8"));
		},
	};

	#create(
		o: { size?: MachineSize; smbios?: Smbios },
		what: string,
		disk: Disk,
	): MachineInfo {
		const vmid = this.#next++;
		if (!o.smbios) throw new Error("no smbios");
		this.vms.set(vmid, {
			smbios: o.smbios,
			size: o.size,
			running: false,
			disk,
			boots: 0,
			notReady: 0,
			secretEnv: undefined,
			forked: false,
			staleHostname: what === "create" ? this.firstStaleHostnames : 0,
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
		return {
			exec: async (cmd, o) => {
				this.execs.push(
					o?.input === undefined
						? { vmid, cmd }
						: { vmid, cmd, input: o.input },
				);
				this.onExec?.(vmid, cmd);
				const vm = this.#vm(vmid);
				if (!vm.running) throw new Error("QEMU guest agent is not running");
				return this.#exec(vm, cmd, o?.input);
			},
			readFile: async () => Buffer.alloc(0),
			ping: async () => this.vms.get(vmid)?.running === true,
		};
	}

	#exec(vm: FakeVm, cmd: string[], input?: string): ExecResult {
		const ok = (stdout = ""): ExecResult => ({
			exitCode: 0,
			stdout,
			stderr: "",
		});
		const uuid = vm.disk.identity;
		const [c0, c1] = cmd;
		if (c0 === PWSH_EXE && cmd.includes("-File")) {
			const arg = (n: string) => {
				const i = cmd.indexOf(`-${n}`);
				return i < 0 ? undefined : cmd[i + 1];
			};
			if (vm.disk.files.get(GUEST_SCRIPT) === undefined)
				return { exitCode: 1, stdout: "", stderr: "no script" };
			const check = arg("Check");
			if (check === "facts")
				return ok(
					`FACTS ${JSON.stringify({
						computerName: computerNameFor(uuid),
						machineGuid: uuid,
						lsaHash: sha(`${arg("Salt")}${vm.disk.password}`),
						hostKeys: [`SHA256:key-${uuid}`],
						bootsSince: arg("Since") ? vm.boots : null,
					})}\r\n`,
				);
			if (check === "autologon")
				return ok(
					"CHECK autologon_session PASS query user: user console 1 Active\r\n",
				);
			if (check === "vss_events")
				return ok("CHECK vss_events PASS no VSS errors since boot\r\n");
			if (check === "license")
				return ok(
					`LICENSE ${JSON.stringify({ status: "Licensed", editionId: "Professional" })}\r\n`,
				);
			return ok(
				[
					"CHECK os PASS EditionID=Professional",
					`CHECK computer_name PASS ${computerNameFor(uuid)}`,
					`TOOLS ${JSON.stringify({
						pwsh: { direct: "PowerShell 7.6.9", login: "PowerShell 7.6.9" },
						node: { direct: "v26.13.0", login: "v26.13.0" },
						npm: { direct: "11.6.2", login: "11.6.2" },
					})}`,
					`LICENSE ${JSON.stringify({
						status: "Licensed",
						description: "RETAIL channel",
						editionId: "Professional",
					})}`,
					"",
				].join("\r\n"),
			);
		}
		if (c0 === PWSH_EXE && cmd.includes("-EncodedCommand")) {
			const script = Buffer.from(String(cmd.at(-1)), "base64").toString(
				"utf16le",
			);
			if (script.includes("secrets\\files"))
				return ok(vm.disk.files.has(SECRET_FILE) ? "True\r\n" : "False\r\n");
			return { exitCode: 1, stdout: "", stderr: `unknown script ${script}` };
		}
		if (c0 !== AGENT_EXE) return { exitCode: 1, stdout: "", stderr: "?" };
		if (c1 === "call") {
			const method = String(cmd[2]);
			const body = JSON.parse(input ?? "null");
			if (cmd[3] !== "-" || body === null)
				return { exitCode: 2, stdout: "", stderr: "want - and stdin" };
			return this.#call(vm, method, body);
		}
		if (c1 === "doctor")
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
		if (c1 === "logs")
			return ok(
				vm.forked && !this.forkKeepsName
					? `2026-10-31T12:00:00Z INFO event identity.reset machine_id=${uuid}\r\n`
					: "2026-10-31T12:00:00Z INFO agent started\r\n",
			);
		if (c1 === "selftest") return ok("pty selftest ok\r\n");
		if (c1 === "exec") {
			expect(cmd.slice(2, 4)).toEqual(["--user", "user"]);
			const i = cmd.indexOf("--shell");
			if (i >= 0) return this.#shell(vm, String(cmd[i + 1]));
			const argv = cmd.slice(cmd.indexOf("--") + 1);
			if (argv.join(" ") === "cmd /c echo %USERNAME%") return ok("user\r\n");
			if (argv.join(" ") === "npm --version") return ok("11.6.2\r\n");
			return { exitCode: 1, stdout: "", stderr: `not found: ${argv[0]}` };
		}
		return { exitCode: 2, stdout: "", stderr: `unknown ${c1}` };
	}

	#call(vm: FakeVm, method: string, body: Record<string, unknown>): ExecResult {
		const ok = (v: unknown): ExecResult => ({
			exitCode: 0,
			stdout: `${JSON.stringify(v)}\r\n`,
			stderr: "",
		});
		const putSecrets = (b: Record<string, unknown>) => {
			const env = b.secret_env as Record<string, string> | undefined;
			vm.secretEnv = env?.SBX_VERIFY_SECRET;
			for (const f of (b.secret_files ?? []) as {
				name: string;
				content: string;
			}[])
				vm.disk.files.set(
					`C:\\ProgramData\\sbx\\secrets\\files\\${f.name}`,
					Buffer.from(f.content, "base64").toString("utf8"),
				);
		};
		switch (method) {
			case "sbx.agent.v1.System/Info": {
				if (this.agentDead || vm.notReady > 0) {
					vm.notReady--;
					return { exitCode: 1, stdout: "", stderr: "unavailable" };
				}
				const stale = vm.staleHostname > 0;
				if (stale) vm.staleHostname--;
				return ok({
					version: "0.5.0",
					machineId: vm.disk.identity,
					hostname: stale ? "SBXTEMPLATE" : computerNameFor(vm.disk.identity),
					readiness: [{ name: "identity", state: "PHASE_STATE_READY" }],
					...(vm.disk.claimed ? { claim: { sandboxId: "sbx-verify" } } : {}),
				});
			}
			case "sbx.agent.v1.System/Claim":
				vm.disk.claimed = true;
				putSecrets(body);
				return ok({ ready: true, hostnameApplied: false });
			case "sbx.agent.v1.System/UpdateSecrets":
				putSecrets(body);
				return ok({ ready: true });
			case "sbx.agent.v1.System/PrepareStop":
				vm.disk.files.delete(SECRET_FILE);
				vm.secretEnv = undefined;
				return ok({ secretFilesWiped: true });
			case "sbx.agent.v1.Filesystem/MakeDir":
				return ok({ info: { path: body.path }, created: true });
			case "sbx.agent.v1.Filesystem/Stat": {
				const c = vm.disk.files.get(String(body.path));
				if (c === undefined)
					return { exitCode: 1, stdout: "", stderr: "not_found" };
				return ok({ info: { path: body.path, size: String(c.length) } });
			}
			case "sbx.agent.v1.Filesystem/Move": {
				const c = vm.disk.files.get(String(body.src)) ?? "";
				vm.disk.files.delete(String(body.src));
				vm.disk.files.set(String(body.dst), c);
				return ok({ info: { path: body.dst } });
			}
			case "sbx.agent.v1.Filesystem/List": {
				const dir = `${String(body.path)}\\`;
				return ok({
					entries: [...vm.disk.files.keys()]
						.filter((k) => k.startsWith(dir))
						.map((k) => ({ path: k, name: k.slice(dir.length) })),
				});
			}
			case "sbx.agent.v1.Filesystem/Remove": {
				const dir = String(body.path);
				let existed = false;
				for (const k of [...vm.disk.files.keys()])
					if (k.startsWith(`${dir}\\`)) {
						vm.disk.files.delete(k);
						existed = true;
					}
				return ok({ existed });
			}
		}
		return { exitCode: 1, stdout: "", stderr: `unimplemented ${method}` };
	}

	#shell(vm: FakeVm, script: string): ExecResult {
		const ok = (stdout = ""): ExecResult => ({
			exitCode: 0,
			stdout,
			stderr: "",
		});
		const override = this.shellCodes[script];
		if (override !== undefined)
			return { exitCode: override, stdout: "", stderr: "" };
		const c = SHELL_CASES.find((x) => x.script === script);
		if (c)
			return {
				exitCode: c.want,
				stdout: c.stdout ? `${c.stdout}\r\n` : "",
				stderr: "",
			};
		const quoted = [...script.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
		if (script.includes("SBX_VERIFY_SECRET")) {
			const f = vm.disk.files.get(SECRET_FILE);
			return ok(
				`env=${vm.secretEnv === undefined ? "absent" : sha(vm.secretEnv)}\r\nfile=${f === undefined ? "absent" : sha(f)}\r\n`,
			);
		}
		if (script.includes("ConvertFrom-SecureString -SecureString")) {
			const blob = vm.disk.files.get(DPAPI);
			const m = /^dpapi:(.*):(.*)$/.exec(blob ?? "");
			if (!m || m[1] !== vm.disk.password)
				return { exitCode: 1, stdout: "", stderr: "Key not valid for use" };
			return ok(`${m[2]}\r\n`);
		}
		if (script.includes("ConvertFrom-SecureString")) {
			vm.disk.files.set(DPAPI, `dpapi:${vm.disk.password}:${quoted[0]}`);
			return ok();
		}
		if (script.startsWith("Set-Content")) {
			vm.disk.files.set(quoted[0] ?? "", quoted[1] ?? "");
			return ok();
		}
		if (script.startsWith("Get-Content")) {
			const f = vm.disk.files.get(quoted[0] ?? "");
			return f === undefined
				? { exitCode: 1, stdout: "", stderr: "not found" }
				: ok(f);
		}
		return { exitCode: 1, stdout: "", stderr: `unknown script ${script}` };
	}
}

function setup() {
	const w = new WinWorld();
	const logs: string[] = [];
	const ram: string[] = [];
	const deps: VerifyDeps = {
		machines: w.machines,
		io: (vmid) => w.io(vmid),
		node: {
			call: async () => {
				throw new Error("no host scan on windows");
			},
		},
		ramGuard: {
			reserve: async (vmid, mb) => {
				ram.push(`reserve ${vmid} ${mb}`);
				w.log.push(`reserve ${vmid}`);
			},
			release: (vmid) => {
				ram.push(`release ${vmid}`);
				w.log.push(`release ${vmid}`);
			},
		},
		verifyScript: "# verify.ps1\r\n",
		secretFiles: {
			updateSigningKey: "/nonexistent/a",
			pveToken: "/nonexistent/b",
			nodeSshKey: "/nonexistent/c",
			devCaKey: "/nonexistent/d",
		},
		windows: w.windows,
		log: (m) => logs.push(m),
		now: () => w.t,
		sleep: async (ms) => {
			w.t += ms;
		},
		pollMs: 1000,
		randomUUID: (() => {
			const ids = [UUID_A, UUID_B];
			return () => ids.shift() ?? "99999999-9999-4999-8999-999999999999";
		})(),
	};
	return { w, deps, logs, ram };
}

describe("verifyWindows", () => {
	it("checks A, its secrets and hard stop, VSS, a fork B with its boots, then removes everything", async () => {
		const { w, deps, ram } = setup();
		const v = await verifyWindows(deps, manifest(), {});
		expect(failed(v.checks)).toEqual([]);
		expect(v.ok).toBe(true);
		expect(v.fork).toEqual({ ok: true });
		const ids = v.checks.map((c) => c.id);
		for (const id of [
			"os",
			"computer_name",
			"tool_pwsh",
			"tool_npm",
			"license_edition",
			"agent_ready",
			"agent_version",
			"agent_identity",
			"agent_tunnel_url",
			"tunnel_connected",
			"shell_exit_7",
			"shell_native_exit",
			"shell_cmdlet_error",
			"shell_ok",
			"agent_username",
			"agent_npm_argv",
			"agent_selftest_pty",
			"agent_files",
			"secret_env_visible",
			"secret_file_visible",
			"prepare_stop_wiped",
			"prepare_stop_file_gone",
			"hard_stop_secret_wiped",
			"vss_freeze",
			"vss_events",
			"fork_name",
			"fork_marker",
			"fork_dpapi",
			"fork_password_kept",
			"fork_one_reboot",
			"fork_autologon_session",
			"hard_stop_restart",
			"boot_times",
		])
			expect(ids).toContain(id);
		expect(w.log).toEqual([
			"create 501",
			"reserve 501",
			"start 501",
			"stop 501",
			"start 501",
			"snapshot 501",
			"shutdown 501 120",
			"release 501",
			"fork 502",
			"reserve 502",
			"start 502",
			"shutdown 502 120",
			"start 502",
			"stop 502",
			"start 502",
			"delete 502",
			"delete-snapshot snap501",
			"delete 501",
			"release 502",
		]);
		expect(ram).toEqual([
			"reserve 501 4096",
			"release 501",
			"reserve 502 4096",
			"release 502",
		]);
		expect(w.vms.size).toBe(0);
		expect(w.snaps.size).toBe(0);
		const b = v.boot;
		expect(b.firstBootToAgentReadyMs).toBeGreaterThan(40_000);
		expect(b.identityChangeBootMs).toBeGreaterThan(b.bootToAgentReadyMs ?? 0);
		expect(b.bootToAgentReadyMs).toBeGreaterThan(40_000);
		expect(b.hardStopRestartMs).toBeGreaterThan(40_000);
		expect(b.freezeMs).toBe(1500);
		expect(b.first.startToQgaMs).toBe(40_000);
		expect(v.license).toMatchObject({ status: "Licensed", channel: "retail" });
	});

	it("slow host: quiesced snapshot retried once, then crash-consistent with a WARN; fork checks decide", async () => {
		const { w, deps } = setup();
		w.snapshotOutcomes = ["budget", "autoThawed"];
		const v = await verifyWindows(deps, manifest(), {});
		expect(failed(v.checks)).toEqual([]);
		expect(v.ok).toBe(true);
		expect(v.fork).toEqual({ ok: true });
		const warn = v.checks.find((c) => c.id === "vss_snapshot");
		expect(warn?.status).toBe("WARN");
		expect(warn?.evidence).toMatch(/14200 ms/);
		expect(warn?.evidence).toMatch(/auto-thawed.*12300 ms/);
		expect(warn?.evidence).toMatch(/crash-consistent/);
		expect(warn?.evidence).toMatch(/slow host/);
		for (const id of ["fork_marker", "fork_dpapi", "fork_name"])
			expect(v.checks.find((c) => c.id === id)?.status).toBe("PASS");
		const snaps = w.log.filter((l) => l.includes("snapshot"));
		expect(snaps).toEqual([
			"snapshot 501",
			"snapshot 501",
			"delete-snapshot snap501",
			"snapshot 501 crash",
			"delete-snapshot snap501",
		]);
		expect(w.snaps.size).toBe(0);
	});

	it("one slow quiesced snapshot: the retry is quiesced, no WARN", async () => {
		const { w, deps } = setup();
		w.snapshotOutcomes = ["autoThawed"];
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(true);
		expect(v.checks.some((c) => c.id === "vss_snapshot")).toBe(false);
		expect(w.log.filter((l) => l.startsWith("snapshot"))).toEqual([
			"snapshot 501",
			"snapshot 501",
		]);
		expect(v.boot.freezeMs).toBe(1500);
	});

	it("other snapshot errors are not retried", async () => {
		const { w, deps } = setup();
		const orig = w.machines.snapshot;
		w.machines.snapshot = async (vmid, o) => {
			if (!o?.crashConsistent) throw new Error("lv.snapshot: pool full");
			return orig(vmid, o);
		};
		await expect(verifyWindows(deps, manifest(), {})).rejects.toThrow(
			/pool full/,
		);
		expect(w.log.filter((l) => l.startsWith("snapshot"))).toEqual([]);
		expect(w.vms.size).toBe(0);
	});

	it("gives A and B their own smbios with the tunnel URL and 2 vCPU / 4 GB", async () => {
		const { w, deps } = setup();
		const made: { size?: MachineSize; smbios?: Smbios }[] = [];
		deps.machines = {
			...w.machines,
			create: async (o) => {
				made.push({ ...o });
				return w.machines.create(o);
			},
			fork: async (s, o) => {
				made.push({ ...o });
				return w.machines.fork(s, o);
			},
		};
		await verifyWindows(deps, manifest(), {});
		expect(made.map((o) => o.size)).toEqual([
			{ cores: 2, memoryMb: 4096 },
			{ cores: 2, memoryMb: 4096 },
		]);
		expect(made.map((o) => o.smbios?.uuid)).toEqual([UUID_A, UUID_B]);
		for (const o of made) {
			expect(o.smbios?.family).toBe(`sbxt1:${TEST_TUNNEL_URL}`);
			expect(o.smbios?.serial).toMatch(
				new RegExp(`^sbx1:${o.smbios?.uuid}:[A-Za-z0-9_-]{43}$`),
			);
		}
	});

	it("never puts secret values on a guest command line", async () => {
		const { w, deps } = setup();
		await verifyWindows(deps, manifest(), {});
		const claim = w.execs.find((e) => e.cmd[2] === "sbx.agent.v1.System/Claim");
		expect(claim?.cmd).toEqual([
			AGENT_EXE,
			"call",
			"sbx.agent.v1.System/Claim",
			"-",
		]);
		const body = JSON.parse(claim?.input ?? "{}");
		const env = body.secret_env.SBX_VERIFY_SECRET as string;
		const file = Buffer.from(body.secret_files[0].content, "base64").toString(
			"utf8",
		);
		expect(env.length).toBeGreaterThan(16);
		for (const e of w.execs) {
			const line = e.cmd.join(" ");
			expect(line).not.toContain(env);
			expect(line).not.toContain(file);
		}
	});

	it("writes verify.ps1 to both machines and runs it with the expected values", async () => {
		const { w, deps } = setup();
		await verifyWindows(deps, manifest(), {});
		expect(w.written.get(`501 ${GUEST_SCRIPT}`)).toBe("# verify.ps1\r\n");
		expect(w.written.get(`502 ${GUEST_SCRIPT}`)).toBe("# verify.ps1\r\n");
		const full = w.execs.find(
			(e) => e.cmd[0] === PWSH_EXE && !e.cmd.includes("-Check"),
		);
		const args = full?.cmd.slice(full.cmd.indexOf(GUEST_SCRIPT) + 1);
		expect(args).toEqual([
			"-MachineId",
			UUID_A,
			"-ExpectSubnet",
			"10.88.0.0/24",
			"-EditionId",
			"Professional",
			"-Build",
			"26300",
			"-Tools",
			"pwsh,node,npm",
			"-HostUnixMs",
			expect.stringMatching(/^\d+$/),
		]);
	});

	it("pwsh exit-code contract assertions fail on wrong codes", async () => {
		const { w, deps } = setup();
		w.shellCodes["exit 7"] = 1;
		w.shellCodes["cmd /c exit 3"] = 1;
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(failed(v.checks)).toEqual(["shell_exit_7", "shell_native_exit"]);
	});

	it("fails the fork checks when the fork keeps the source's name", async () => {
		const { w, deps } = setup();
		w.forkKeepsName = true;
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(v.fork).toEqual({ ok: false });
		expect(failed(v.checks)).toContain("fork_agent_ready");
		expect(w.vms.size).toBe(0);
	});

	it("fails a hard stop restart slower than a normal boot + 10 s", async () => {
		const { w, deps } = setup();
		const stop = w.machines.stop;
		deps.machines = {
			...w.machines,
			stop: async (vmid) => {
				await stop(vmid);
				if (vmid === 502) w.bootMs = 60_000;
			},
		};
		const v = await verifyWindows(deps, manifest(), {});
		expect(failed(v.checks)).toEqual(["hard_stop_restart"]);
	});

	it("retries a hard stop that hits the VM lock held by qmeventd", async () => {
		const { w, deps } = setup();
		const stop = w.machines.stop;
		let locked = 2;
		deps.machines = {
			...w.machines,
			stop: async (vmid) => {
				if (vmid === 502 && locked-- > 0)
					throw new Error(
						"task failed: can't lock file '/var/lock/qemu-server/lock-502.conf' - got timeout",
					);
				await stop(vmid);
			},
		};
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(true);
		expect(locked).toBe(-1);
	});

	it("does not retry other stop errors", async () => {
		const { w, deps } = setup();
		let calls = 0;
		deps.machines = {
			...w.machines,
			stop: async () => {
				calls++;
				throw new Error("VM 501 not running");
			},
		};
		await expect(verifyWindows(deps, manifest(), {})).rejects.toThrow(
			/not running/,
		);
		expect(calls).toBe(1);
	});

	it("cleanup runs on failure", async () => {
		const { w, deps, ram } = setup();
		deps.machines = {
			...w.machines,
			snapshot: async () => {
				throw new Error("lvcreate failed");
			},
		};
		await expect(verifyWindows(deps, manifest(), {})).rejects.toThrow(
			/lvcreate failed/,
		);
		expect(w.vms.size).toBe(0);
		expect(ram).toEqual(["reserve 501 4096", "release 501"]);
		expect(w.log.at(-2)).toBe("delete 501");
	});

	it("an agent that never gets ready is a FAIL, and the machine is removed", async () => {
		const { w, deps } = setup();
		w.agentDead = true;
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(failed(v.checks)).toEqual(["agent_ready"]);
		expect(w.log).toEqual([
			"create 501",
			"reserve 501",
			"start 501",
			"delete 501",
			"release 501",
		]);
	});

	it("the fork is ready only once its computer name is the new one", async () => {
		const { w, deps } = setup();
		w.forkStaleHostnames = 2;
		const v = await verifyWindows(deps, manifest(), {});
		expect(failed(v.checks)).toEqual([]);
		const ready = v.checks.find((c) => c.id === "fork_agent_ready");
		expect(ready?.evidence).toContain(`hostname ${computerNameFor(UUID_B)}`);
	});

	it("the first boot is ready only once the agent renamed the machine (R16)", async () => {
		const { w, deps } = setup();
		w.firstStaleHostnames = 3;
		const v = await verifyWindows(deps, manifest(), {});
		expect(failed(v.checks)).toEqual([]);
		const ready = v.checks.find((c) => c.id === "agent_ready");
		expect(ready?.evidence).toContain(`hostname ${computerNameFor(UUID_A)}`);
		const vm = w.execs.filter((e) => e.vmid === 501);
		// No Info answer with the interim name ends the wait: three stale answers were polled.
		expect(
			vm.filter((e) => e.cmd.includes("sbx.agent.v1.System/Info")).length,
		).toBeGreaterThan(3);
	});

	it("a thaw is attempted when the freeze call threw", async () => {
		const { w, deps } = setup();
		let thaws = 0;
		deps.windows = {
			...(deps.windows as NonNullable<VerifyDeps["windows"]>),
			fsfreezeFreeze: async () => {
				throw new Error("freeze timed out");
			},
			fsfreezeThaw: async () => {
				thaws++;
				throw new Error("not frozen");
			},
		};
		const v = await verifyWindows(deps, manifest(), {});
		expect(thaws).toBe(1);
		const vss = v.checks.find((c) => c.id === "vss_freeze");
		expect(vss?.status).toBe("FAIL");
		expect(vss?.evidence).toContain("freeze timed out");
		expect(vss?.evidence).not.toContain("not frozen");
		expect(w.vms.size).toBe(0);
	});

	it("vss_freeze fails when VSS had already thawed by itself at the thaw", async () => {
		const { w, deps } = setup();
		deps.windows = {
			...(deps.windows as NonNullable<VerifyDeps["windows"]>),
			fsfreezeThaw: async () => {
				w.frozen = false;
				return { autoThawed: true };
			},
		};
		const v = await verifyWindows(deps, manifest(), {});
		const vss = v.checks.find((c) => c.id === "vss_freeze");
		expect(vss?.status).toBe("FAIL");
		expect(vss?.evidence).toMatch(/already thawed by itself/);
	});

	it("cleans up the fork, the snapshot and the source when the fork fails to start", async () => {
		const { w, deps, ram } = setup();
		deps.machines = {
			...w.machines,
			start: async (vmid) => {
				if (w.vms.get(vmid)?.forked) throw new Error("fork start failed");
				return w.machines.start(vmid);
			},
		};
		await expect(verifyWindows(deps, manifest(), {})).rejects.toThrow(
			/fork start failed/,
		);
		expect(w.vms.size).toBe(0);
		expect(w.snaps.size).toBe(0);
		const deletes = w.log.filter((l) => l.startsWith("delete"));
		expect(deletes).toEqual([
			"delete 502",
			"delete-snapshot snap501",
			"delete 501",
		]);
		expect(ram.filter((r) => r.startsWith("reserve")).length).toBe(
			ram.filter((r) => r.startsWith("release")).length,
		);
		expect(ram.at(-1)).toBe("release 502");
	});

	it("stops between stages on abort and still cleans up", async () => {
		const { w, deps } = setup();
		const ac = new AbortController();
		w.onExec = (_vmid, cmd) => {
			if (cmd[1] === "doctor") ac.abort(new Error("interrupted by SIGINT"));
		};
		await expect(
			verifyWindows(deps, manifest(), { signal: ac.signal }),
		).rejects.toThrow(/SIGINT/);
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
		const v = await verifyWindows(deps, manifest(), {});
		expect(v.ok).toBe(false);
		expect(v.checks.at(-1)).toMatchObject({ id: "cleanup", status: "FAIL" });
	});

	it("keeps the machines and the snapshot with keep", async () => {
		const { w, deps } = setup();
		await verifyWindows(deps, manifest(), { keep: true });
		expect(w.log.filter((l) => l.startsWith("delete"))).toEqual([]);
		expect(w.vms.size).toBe(2);
	});

	it("verifyTemplate dispatches a windows manifest to the windows profile", async () => {
		const { w, deps } = setup();
		const v = await verifyTemplate(deps, manifest(), {});
		expect(v.ok).toBe(true);
		expect(w.log[0]).toBe("create 501");
		expect(v.boot.identityChangeBootMs).toBeDefined();
	});
});

class FakeRegistrar implements TunnelRegistrar {
	calls: string[] = [];
	state: string | null = "connected";
	async register(machineId: string, bsHashHex: string) {
		this.calls.push(`register ${machineId} ${bsHashHex.length}`);
	}
	async sessionState(machineId: string) {
		this.calls.push(`state ${machineId}`);
		return this.state;
	}
	async unregister(machineId: string) {
		this.calls.push(`unregister ${machineId}`);
	}
}

describe("verifyWindows with the tunnel connect check", () => {
	const URL = "wss://tunnel.10-0-0-90.sslip.io/v1/connect";

	it("registers A, waits for its session and counts it in the first boot", async () => {
		const { deps } = setup();
		const reg = new FakeRegistrar();
		const v = await verifyWindows(deps, manifest(), {
			connect: { url: URL, registrar: reg },
		});
		expect(v.checks.find((c) => c.id === "tunnel_connected")).toMatchObject({
			status: "PASS",
		});
		expect(v.checks.find((c) => c.id === "agent_tunnel_url")).toMatchObject({
			status: "PASS",
		});
		expect(reg.calls[0]).toBe(`register ${UUID_A} 64`);
		expect(reg.calls.at(-1)).toBe(`unregister ${UUID_A}`);
	});

	it("fails when no session connects", async () => {
		const { deps } = setup();
		const reg = new FakeRegistrar();
		reg.state = null;
		const v = await verifyWindows(deps, manifest(), {
			connect: { url: URL, registrar: reg },
		});
		expect(failed(v.checks)).toEqual(["tunnel_connected"]);
	});
});

/** pwsh comes from mise.toml (`powershell`); `PWSH=<path>` overrides it. */
const PWSH = process.env.PWSH ?? "pwsh";

describe("verify.ps1", () => {
	const text = () => readFileSync(VERIFY_PS1, "utf8");

	it("parses without errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-verify-ps1-"));
		try {
			const script = join(dir, "parse.ps1");
			writeFileSync(
				script,
				`$errs = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$errs)
foreach ($e in $errs) { Write-Output "$($e.Extent.StartLineNumber): $($e.Message)" }
exit $errs.Count
`,
			);
			const r = spawnSync(
				PWSH,
				["-NoProfile", "-NonInteractive", "-File", script, VERIFY_PS1],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			expect(r.stdout + r.stderr).toBe("");
			expect(r.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("helpers: CHECK lines, the subnet test, first lines, native exit codes", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-verify-ps1-"));
		try {
			const script = join(dir, "helpers.ps1");
			writeFileSync(
				script,
				`$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$null)
$want = @('Report', 'Test-InCidr', 'Get-FirstLine', 'Invoke-Capture')
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($f.Name -in $want) { . ([scriptblock]::Create($f.Extent.Text)) }
}
Report a ($true -and 1 -eq 1) "x\`n  y"
Report b INFO ('z' * 700)
Write-Output ('cidr ' + (Test-InCidr '10.88.0.17' '10.88.0.0/24') + (Test-InCidr '10.89.0.17' '10.88.0.0/24') + (Test-InCidr '1.2.3.4' '0.0.0.0/0') + (Test-InCidr '10.88.0.1' '10.88.0.1/32'))
Write-Output ('first ' + (Get-FirstLine ([pscustomobject]@{ Code = 0; Lines = @(' v1 ', 'x') })) + '|' + (Get-FirstLine ([pscustomobject]@{ Code = 3; Lines = @('boom') })))
$r = Invoke-Capture 'pwsh' @('-NoProfile', '-Command', 'exit 5')
Write-Output "capture $($r.Code)"
`,
			);
			const r = spawnSync(
				PWSH,
				["-NoProfile", "-NonInteractive", "-File", script, VERIFY_PS1],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			expect(r.stderr).toBe("");
			const lines = r.stdout.split(/\r?\n/);
			expect(lines[0]).toBe("CHECK a PASS x y");
			expect(lines[1]).toBe(`CHECK b INFO ${"z".repeat(600)}`);
			expect(lines.slice(2, 5)).toEqual([
				"cidr TrueFalseTrueTrue",
				"first v1|error: rc=3 boom",
				"capture 5",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks where it builds the agent exec argv", () => {
		const t = text();
		const marker =
			"# agent CLI contract — see apps/template-builder/src/windows/verify.ts";
		expect(t).toContain(marker);
		// The marker sits in the function that builds the exec argv.
		const at = t.indexOf(marker);
		expect(t.indexOf("'exec', '--user'", at)).toBeGreaterThan(at);
	});

	it("requires pwsh 7 and takes the parameters verifyWindows passes", () => {
		const t = text();
		expect(t.split(/\r?\n/)[0]).toBe("#requires -Version 7");
		for (const p of [
			"MachineId",
			"ExpectSubnet",
			"EditionId",
			"Build",
			"Tools",
			"HostUnixMs",
			"Salt",
			"Since",
			"Check",
		])
			expect(t).toMatch(new RegExp(`\\[(string|long)\\]\\$${p}\\b`));
	});

	it("has the checks of spec 15.1 the host does not run itself", () => {
		const t = text();
		for (const id of [
			"os",
			"computer_name",
			"machine_guid",
			"first_boot_reboots",
			"sbx_unattend_gone",
			"panther_clean",
			"listen_tcp",
			"listen_udp",
			"firewall_profiles",
			"firewall_rules",
			"sshd_config",
			"sshd_service",
			"ssh_host_keys",
			"ssh_default_shell",
			"ssh_cert_login",
			"agent_service",
			"agent_failure_actions",
			"agent_early",
			"user_admin",
			"user_password",
			"lsa_secret",
			"local_accounts",
			"uac",
			"autologon_session",
			"services_disabled",
			"defender_off",
			"waasmedic_off",
			"offline_log",
			"fast_startup_off",
			"hibernation_off",
			"pagefile",
			"crash_dump",
			"vbs_off",
			"bitlocker_off",
			"tpm_ready",
			"bcd",
			"winre_off",
			"codepage",
			"firstboot_log",
			"npm_prefix",
			"ipv4",
			"dns",
			"https",
			"time_sync",
			"timezone",
			"trim",
			"leftovers",
			"vss_events",
			"lsa_hash",
		])
			expect(t, id).toMatch(new RegExp(`Report ${id} `));
		expect(t).toMatch(/'TOOLS '/);
		expect(t).toMatch(/'LICENSE '/);
		expect(t).toMatch(/'FACTS '/);
	});

	/** Runs `body` after loading the named functions of verify.ps1 (StrictMode on). */
	const runFunctions = (names: string[], body: string) => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-verify-ps1-"));
		try {
			const script = join(dir, "fn.ps1");
			writeFileSync(
				script,
				`Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($args[0], [ref]$null, [ref]$null)
$want = @(${names.map((n) => `'${n}'`).join(", ")})
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  if ($f.Name -in $want) { . ([scriptblock]::Create($f.Extent.Text)) }
}
$SetupBoots = 2
${body}
`,
			);
			const r = spawnSync(
				PWSH,
				["-NoProfile", "-NonInteractive", "-File", script, VERIFY_PS1, dir],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			return { status: r.status, stdout: r.stdout, stderr: r.stderr };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it("first_boot_reboots: setup's boots plus one planned restart by sbx-agent.exe (R16)", () => {
		const r = runFunctions(
			["Get-RestartProcessName", "Get-FirstBootVerdict"],
			String.raw`$agent = Get-RestartProcessName 'C:\Program Files\sbx-agent\versions\0.5.0\sbx-agent.exe (SBXTEMPLATE)'
Write-Output "name $agent|$(Get-RestartProcessName 'C:\Program Files (x86)\x\Setup.EXE')"
foreach ($c in @(
    @{ b = 2; by = @() }, @{ b = 3; by = @() }, @{ b = 3; by = @($agent) }, @{ b = 4; by = @($agent) },
    @{ b = 4; by = @($agent, $agent) }, @{ b = 1; by = @($agent) }, @{ b = 0; by = @() }, @{ b = 3; by = @('winlogon.exe') }
)) {
  $v = Get-FirstBootVerdict $c.b ([string[]]$c.by)
  Write-Output "$($c.b) $($c.by.Count) $($v.Ok)"
}
Write-Output (Get-FirstBootVerdict 3 @($agent)).Evidence`,
		);
		expect(r.stderr).toBe("");
		const lines = r.stdout.trim().split(/\r?\n/);
		expect(lines.slice(0, 9)).toEqual([
			"name sbx-agent.exe|Setup.EXE",
			"2 0 True",
			"3 0 False",
			"3 1 True",
			"4 1 False",
			"4 2 False",
			"1 1 True",
			"0 0 False",
			"3 1 False",
		]);
		expect(lines[9]).toMatch(/3 boots since the seal/);
		expect(lines[9]).toMatch(/sbx-agent\.exe/);
	});

	it("users: the salted hash of the LSA secret works with an empty salt (null-safe)", () => {
		const secret = "p@ss-\u00e9";
		const bytes = Buffer.from(secret, "utf16le");
		const r = runFunctions(
			["Get-SaltedHash"],
			`$s = [Convert]::FromHexString('${bytes.toString("hex")}')
Write-Output (Get-SaltedHash '' $s)
Write-Output (Get-SaltedHash $null $s)
Write-Output (Get-SaltedHash '0a0b' $s)
Write-Output (Get-SaltedHash '' ([byte[]]::new(0)))`,
		);
		expect(r.stderr).toBe("");
		expect(r.stdout.trim().split(/\r?\n/)).toEqual([
			createHash("sha256").update(bytes).digest("hex"),
			createHash("sha256").update(bytes).digest("hex"),
			createHash("sha256")
				.update(Buffer.concat([Buffer.from([10, 11]), bytes]))
				.digest("hex"),
			createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
		]);
	});

	it("vss_events: the benign 8194 IVssWriterCallback 0x80070005 is INFO, other VSS errors still fail", () => {
		const r = runFunctions(
			["Report", "Test-VssEvents"],
			`$BootTime = Get-Date
function mk($id, $msg) { [pscustomobject]@{ Id = $id; Message = $msg } }
$benign = 'Unexpected error querying for the IVssWriterCallback interface. hr = 0x80070005, Access is denied.'
$script:events = @()
function Get-WinEvent { param($FilterHashtable, $ErrorAction) $script:events }
Test-VssEvents
$script:events = @((mk 8194 $benign), (mk 8194 $benign))
Test-VssEvents
$script:events = @((mk 8194 $benign), (mk 12302 'VSS writer failed'))
Test-VssEvents
$script:events = @((mk 8194 'Unexpected error querying for the IVssWriterCallback interface. hr = 0x80040154'))
Test-VssEvents`,
		);
		expect(r.stderr).toBe("");
		const lines = r.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^CHECK vss_events PASS /);
		expect(lines[1]).toMatch(
			/^CHECK vss_events INFO 2 known benign event 8194/,
		);
		expect(lines[2]).toMatch(
			/^CHECK vss_events FAIL 1 VSS errors: 12302 .*1 known benign 8194 ignored/,
		);
		expect(lines[3]).toMatch(/^CHECK vss_events FAIL 1 VSS errors: 8194 /);
	});

	it("firstboot_log: present and ends with done", () => {
		const r = runFunctions(
			["Report", "Test-FirstBootLog"],
			`$d = $args[1]
Test-FirstBootLog (Join-Path $d 'missing.log')
Set-Content -LiteralPath (Join-Path $d 'ok.log') -Value @('[10:00:00] start', '[10:00:01] ERROR service Spooler: boom', '[10:00:02] done', '')
Test-FirstBootLog (Join-Path $d 'ok.log')
Set-Content -LiteralPath (Join-Path $d 'cut.log') -Value @('[10:00:00] start', '[10:00:01] service WinRM: Start=4, Stopped')
Test-FirstBootLog (Join-Path $d 'cut.log')
Set-Content -LiteralPath (Join-Path $d 'empty.log') -Value @()
Test-FirstBootLog (Join-Path $d 'empty.log')`,
		);
		expect(r.stderr).toBe("");
		const lines = r.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^CHECK firstboot_log FAIL .*missing/);
		expect(lines[1]).toMatch(/^CHECK firstboot_log PASS .*ERROR lines: 1/);
		expect(lines[2]).toMatch(/^CHECK firstboot_log FAIL .*WinRM/);
		expect(lines[3]).toMatch(/^CHECK firstboot_log FAIL /);
	});

	it("firewall_rules judges the active store when the policy ignores local rules", () => {
		const t = text();
		const fw = t.slice(t.indexOf("function Test-Firewall"));
		expect(t).toMatch(
			/^\$FirewallPolicy = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsFirewall'$/m,
		);
		expect(fw).toMatch(
			/\$names = @\('DomainProfile', 'PrivateProfile', 'PublicProfile'\)/,
		);
		expect(fw).toMatch(
			/foreach \(\$p in \$names\)[^\n]*\$FirewallPolicy\\\$p" 'AllowLocalPolicyMerge'/,
		);
		expect(fw).toMatch(
			/Get-NetFirewallRule -PolicyStore ActiveStore -Direction Inbound -Action Allow -Enabled True/,
		);
		// Without the policy: the local rules as before.
		expect(fw).toMatch(
			/Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction/,
		);
	});

	it("firewall_rules: shields up (AllowInboundRules False everywhere) makes leftover allow rules ineffective", () => {
		const r = runFunctions(
			["Report", "Test-Firewall"],
			String.raw`$FirewallPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsFirewall'
function prof($n, $allow) { [pscustomobject]@{ Name = $n; Enabled = 'True'; DefaultInboundAction = 'Block'; NotifyOnListen = 'False'; AllowInboundRules = $allow } }
function Get-RegValue([string]$Path, [string]$Name) { $script:reg["$(Split-Path -Leaf $Path)/$Name"] }
function Get-NetFirewallProfile { param($PolicyStore) $script:profiles }
function Get-NetFirewallRule { param($PolicyStore, $Direction, $Action, $Enabled, $ErrorAction) $script:rules }
$appx = [pscustomobject]@{ Name = 'Microsoft.WindowsStore_8wekyb3d8bbweS-1-5-21-1-1000-In-Allow-ServerCapability' }
$script:reg = @{}
foreach ($p in @('DomainProfile', 'PrivateProfile', 'PublicProfile')) { $script:reg["$p/AllowLocalPolicyMerge"] = 0; $script:reg["$p/DoNotAllowExceptions"] = 1 }
$script:profiles = @((prof 'Domain' 'False'), (prof 'Private' 'False'), (prof 'Public' 'False'))
$script:rules = @($appx)
Test-Firewall
$script:profiles = @((prof 'Domain' 'False'), (prof 'Private' 'NotConfigured'), (prof 'Public' 'False'))
Test-Firewall
$script:rules = @()
Test-Firewall`,
		);
		expect(r.stderr).toBe("");
		const lines = r.stdout
			.trim()
			.split(/\r?\n/)
			.filter((l) => l.startsWith("CHECK firewall_rules"));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^CHECK firewall_rules PASS /);
		expect(lines[0]).toMatch(/AllowInboundRules False/);
		expect(lines[0]).toMatch(/ineffective.*WindowsStore/);
		expect(lines[0]).toMatch(/DoNotAllowExceptions: DomainProfile=1/);
		expect(lines[1]).toMatch(/^CHECK firewall_rules FAIL .*WindowsStore/);
		expect(lines[1]).toMatch(/Private=NotConfigured/);
		expect(lines[2]).toMatch(/^CHECK firewall_rules PASS /);
	});

	it("autologon_session: the user's session must be unlocked; evidence says why not", () => {
		const r = runFunctions(
			["Report", "Test-Autologon"],
			String.raw`$UserName = 'user'
function Invoke-Capture { param($FilePath, $ArgumentList) [pscustomobject]@{ Code = 0; Lines = $script:q; Text = ($script:q -join "\n") } }
function Get-Process { param($Name, $ErrorAction) @($script:procs | Where-Object { $_.Name -eq $Name }) }
function Get-SessionLockState { param([int]$SessionId) $script:lockQueried = $SessionId; $script:lock }
function Start-Sleep { param($Seconds) }
function proc($n, $sid) { [pscustomobject]@{ Name = $n; Id = 100 + $sid; SessionId = $sid } }
$active = @(' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME', '>user                  console             1  Active      none   10/31/2026 9:00 AM')
$script:q = $active
$script:procs = @()
$script:lock = 'unlocked'
Test-Autologon -WaitSeconds 0
Write-Output "queried $script:lockQueried"
$script:procs = @((proc 'LogonUI' 1), (proc 'LockApp' 1))
$script:lock = 'locked'
Test-Autologon -WaitSeconds 0
# LogonUI of another session (a second console logon screen) does not matter.
$script:procs = @((proc 'LogonUI' 2))
$script:lock = 'unlocked'
Test-Autologon -WaitSeconds 0
$script:q = @(' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME')
$script:procs = @()
Test-Autologon -WaitSeconds 0`,
		);
		expect(r.stderr).toBe("");
		const lines = r.stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toMatch(
			/^CHECK autologon_session PASS .*session 1.*unlocked/,
		);
		expect(lines[1]).toBe("queried 1");
		expect(lines[2]).toMatch(/^CHECK autologon_session FAIL /);
		expect(lines[2]).toMatch(/locked/);
		expect(lines[2]).toMatch(/LogonUI in session 1/);
		expect(lines[2]).toMatch(/LockApp/);
		expect(lines[3]).toMatch(/^CHECK autologon_session PASS /);
		expect(lines[4]).toMatch(
			/^CHECK autologon_session FAIL .*no active session/,
		);
	});

	it("autologon_session polls up to 180 s and reads the lock state through WTSSessionInfoEx", () => {
		const t = text();
		const fn = t.slice(t.indexOf("function Test-Autologon"));
		expect(fn).toMatch(/\[int\]\$WaitSeconds = 180/);
		expect(t).toMatch(/WTSQuerySessionInformation/);
		expect(t).toMatch(/function Get-SessionLockState/);
	});

	it("codepage checks the registry and the active code pages", () => {
		const t = text();
		expect(t).toMatch(/GetACP\(\)/);
		expect(t).toMatch(/GetOEMCP\(\)/);
		expect(t).toMatch(
			/Report codepage \(\$acp -eq '65001' -and \$oem -eq '65001' -and/,
		);
	});

	it("prints only a hash of the LSA secret, never the value", () => {
		const t = text();
		expect(t).toMatch(/SHA256/);
		expect(t).not.toMatch(/GetString\(\$secret/);
	});
});
