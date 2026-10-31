import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Allocator, PveApiError, SqliteStateStore } from "@sbx/pve";
import { FakeNode } from "@sbx/pve/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BuildDeps,
	BuildFailedError,
	type BuildOptions,
	buildTemplate,
} from "../src/build.ts";
import type { Manifest, VerifyResult } from "../src/manifest.ts";
import { loadRecipe, recipeDigest } from "../src/recipe.ts";
import { FileRegistry } from "../src/registry.ts";
import { stepTimeoutMs } from "../src/windows/stages.ts";
import {
	type AgentExecResult,
	BuildPve,
	FAKE_WIN_FACTS,
	FakeWinFiles,
	FakeWinGuest,
	writeAgentPackage,
} from "./fakes.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtures = resolve(import.meta.dirname, "fixtures/templates");
const USER_ISO = "Windows11_Client_x64_en-gb_26300_9457.iso";
const ISO_SHA = "ab".repeat(32);
const VIRTIO_ISO = "sbx-virtio-win-0.1.271.iso";
const VIRTIO_SHA =
	"bbe6166ad86a490caefad438fef8aa494926cb0a1b37fa1212925cfd81656429";
const vm = "/nodes/pve/qemu/598";
const BUILD_JSON = "C:\\ProgramData\\sbx-template\\build.json";
const SYSPREP = [
	"C:\\Windows\\System32\\Sysprep\\sysprep.exe",
	"/generalize",
	"/oobe",
	"/shutdown",
	"/quiet",
	"/unattend:C:\\Windows\\System32\\Sysprep\\sbx-unattend.xml",
];

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "sbx-winbuild-test-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RECIPE = `slug: winbuild
os: windows
extends: null
shared: _windows
source:
  kind: iso-install
  family: client
  drivers: w11
  locale: { formats: en-US, keyboard: en-US, timezone: UTC }
disk: { slot: scsi0, size: 96G }
hw:
  machine: pinned
  cpu: host
  bios: ovmf
  ostype: win11
  scsihw: virtio-scsi-single
  agent: "enabled=1"
  vga: std
  tablet: 1
  rng0: "source=/dev/urandom"
  efidisk0: { efitype: 4m, pre-enrolled-keys: 1, ms-cert: 2023k }
  tpmstate0: { version: v2.0 }
  cloudinit: false
build_vm: { cores: 4, memory_mb: 4096 }
steps: [00-base, reboot, network-up, 10-system, 90-cleanup]
seal: sysprep
offline: [defender-off, waasmedic-off]
options: { vs_buildtools: false }
boot_timeout_s: 1200
install_timeout_s: 2400
verify: windows
vmids: [598]
`;

/** The real _windows files plus fixture steps, and a recipe `winbuild` with pinned ISO sha. */
function templates(isoSha: string): string {
	const dir = tmp();
	cpSync(join(repoRoot, "infra/templates/_windows"), join(dir, "_windows"), {
		recursive: true,
	});
	cpSync(join(fixtures, "_winshared/steps"), join(dir, "_windows/steps"), {
		recursive: true,
	});
	mkdirSync(join(dir, "_windows/files"), { recursive: true });
	writeFileSync(
		join(dir, "_windows/files/appx-remove.txt"),
		"# provisioned packages\nMicrosoft.BingNews\nClipchamp.Clipchamp\nMicrosoft.WindowsCalc*\n",
	);
	mkdirSync(join(dir, "winbuild"));
	writeFileSync(join(dir, "winbuild/template.yaml"), RECIPE);
	const versions = readFileSync(
		join(fixtures, "windows-fixture/versions.toml"),
		"utf8",
	).replace('sha256 = ""', `sha256 = "${isoSha}"`);
	writeFileSync(join(dir, "winbuild/versions.toml"), versions);
	return dir;
}

const VERIFY_OK: VerifyResult = {
	ok: true,
	checks: [{ id: "edition", status: "PASS", evidence: "Professional" }],
	boot: {
		first: { startToQgaMs: 90000, startToIpMs: 95000 },
		hardRestart: { startToQgaMs: 60000, startToIpMs: 61000 },
	},
	kvm: { available: true },
	fork: { ok: true },
	at: "2026-10-30T12:00:00.000Z",
};

function setup(
	over: Partial<BuildOptions> = {},
	o: { pinnedSha?: string } = {},
) {
	const work = tmp();
	const log: string[] = [];
	const messages: string[] = [];
	const pve = new BuildPve(log);
	const node = new FakeNode(log);
	const state = {
		isoSha: ISO_SHA,
		/** The VM stops this many status polls after sysprep started (undefined: never). */
		sysprepStopsAfter: 2 as number | undefined,
		sysprepResult: "running" as AgentExecResult,
		/** The WinPE boot powers off after this many polls. */
		offlineStopsAfter: 2,
		/** The one-time WinPE boot entry is set for the next reboot. */
		peArmed: false,
		/** Reboots with the entry set that start Windows again (the entry ignored). */
		peIgnored: 0,
		/** WinPE runs (no guest agent). */
		winpe: false,
		sysprepStarted: false,
		polls: 0,
	};
	node.handlers["media.remove"] = (a) => ({ removed: a.names, missing: [] });
	node.handlers["media.sha256"] = (a) => ({
		name: a.name,
		size: 6_000_000_000,
		sha256: state.isoSha,
	});
	const disk = { dataPercent: 12.5 };
	node.handlers["lv.tagTemplate"] = (a) => ({
		tagged: [0, 1, 2].map((k) => `base-${a.vmid}-disk-${k}`),
		already: [],
	});
	node.handlers["lv.usage"] = (a) => {
		if (a.name !== "base-598-disk-1") throw new Error(`lv.usage ${a.name}`);
		return { sizeBytes: 96 * 2 ** 30, dataPercent: disk.dataPercent };
	};
	const store = new SqliteStateStore(":memory:");
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: { min: 500, max: 589 },
		templateRange: { min: 597, max: 599 },
		templateVmid: 599,
		occupied: async () => new Set(pve.vms.keys()),
	});
	const registry = new FileRegistry(join(work, "registry"));
	const guest = new FakeWinGuest(log);
	const files = new FakeWinFiles();
	const sysprepCalls: string[][] = [];
	pve.agentExec = (_vmid, command, input) => {
		const w = files.handle(command, input);
		if (w) {
			log.push(`qga:write ${command.at(-1)}`);
			return w;
		}
		if (String(command[0]).endsWith("sysprep.exe")) {
			sysprepCalls.push(command);
			log.push("guest:sysprep");
			state.sysprepStarted = true;
			state.polls = 0;
			return state.sysprepResult;
		}
		return { exitcode: 0 };
	};
	pve.before = (method, path) => {
		// Proxmox refuses to start a running VM.
		if (
			method === "POST" &&
			path === `${vm}/status/start` &&
			pve.vms.get(598)?.status === "running"
		)
			throw new Error(`VM 598 already running`);
		if (method !== "GET" || path !== `${vm}/status/current`) return;
		const v = pve.vms.get(598);
		if (v?.status !== "running") return;
		const limit = state.winpe
			? state.offlineStopsAfter
			: state.sysprepStarted
				? state.sysprepStopsAfter
				: undefined;
		if (limit !== undefined && ++state.polls >= limit) {
			v.status = "stopped";
			state.polls = 0;
			state.sysprepStarted = false;
			state.winpe = false;
		}
	};
	// A reboot with the one-time entry set starts WinPE from the ramdisk.
	guest.onPeSetup = () => {
		state.peArmed = true;
	};
	guest.onReboot = () => {
		if (!state.peArmed) return;
		state.peArmed = false;
		if (state.peIgnored > 0) {
			state.peIgnored--;
			return;
		}
		state.winpe = true;
		state.polls = 0;
	};
	// QGA exists only in the installed Windows, never in WinPE.
	guest.alive = () => pve.vms.get(598)?.status === "running" && !state.winpe;
	const virtio = join(work, "virtio-win-0.1.271.iso");
	writeFileSync(virtio, "virtio-win iso bytes");
	const isos: {
		files: Map<string, string | Buffer>;
		label: string | undefined;
		out: string;
	}[] = [];
	const pkg = writeAgentPackage(work, { os: "windows" });
	let verifyResult = VERIFY_OK;
	let t = Date.parse("2026-10-30T10:00:00Z");
	const deps: BuildDeps = {
		api: pve,
		node,
		allocator,
		registry,
		fetchImage: async () => {
			throw new Error("no base image for windows");
		},
		fetchVirtioWin: async (v) => {
			log.push(`virtio:fetch ${v.version}`);
			return { path: virtio, sha256: v.sha256 };
		},
		io: () => guest,
		makeIso: (f, out, label) => {
			isos.push({ files: f, label, out });
			writeFileSync(out, `iso ${label} with ${f.size} files`);
			log.push(`iso:make ${label}`);
		},
		verify: async () => {
			log.push("verify");
			return verifyResult;
		},
		ramGuard: {
			reserve: async (vmid, mb) => {
				log.push(`ram:reserve ${vmid} ${mb}`);
			},
			release: (vmid) => {
				log.push(`ram:release ${vmid}`);
			},
		},
		log: (msg) => messages.push(msg),
		stepOutput: (_s, chunk) => messages.push(chunk),
		now: () => {
			t += 1000;
			return new Date(t);
		},
		pollMs: 1,
		keyIntervalMs: 0,
	};
	const templatesDir = templates(o.pinnedSha ?? ISO_SHA);
	const opts: BuildOptions = {
		slug: "winbuild",
		node: "pve",
		storage: "local-lvm",
		pool: "sandbox",
		vnet: "sbx0",
		agentPackage: pkg.tar,
		keepOnFailure: false,
		noVerify: false,
		templatesDir,
		updateKeysFile: pkg.keys,
		gitCommit: "c0ffee",
		...over,
	};
	return {
		work,
		log,
		messages,
		pve,
		node,
		allocator,
		registry,
		guest,
		files,
		state,
		disk,
		isos,
		sysprepCalls,
		deps,
		opts,
		templatesDir,
		setVerify: (v: VerifyResult) => {
			verifyResult = v;
		},
	};
}

/** Every entry appears in the log, in this order. */
function expectInOrder(log: string[], seq: string[]) {
	let from = 0;
	for (const want of seq) {
		const i = log.indexOf(want, from);
		if (i < 0)
			throw new Error(
				`"${want}" not found after position ${from} (previous: ${log[from - 1]})\n${log.join("\n")}`,
			);
		from = i + 1;
	}
}

const buildIso = (m: Manifest) => `sbx-build-${m.buildId}.iso`;
const offlineIso = (m: Manifest) => `sbx-offline-${m.buildId}.iso`;

function failed(err: unknown): Manifest {
	expect(err).toBeInstanceOf(BuildFailedError);
	return (err as BuildFailedError).manifest;
}

/** Number of sendkey calls between two log entries. */
function keysBetween(log: string[], from: number, to: number): number {
	return log.slice(from, to).filter((e) => e === `api:PUT ${vm}/sendkey`)
		.length;
}

/** The build password, decoded from the rendered autounattend.xml (base64 UTF-16LE + "Password"). */
function buildPassword(files: Map<string, string | Buffer>): string {
	const xml = String(files.get("autounattend.xml"));
	const value = /<Password>\s*<Value>([^<]+)<\/Value>/.exec(xml)?.[1];
	expect(value).toBeDefined();
	const plain = Buffer.from(String(value), "base64").toString("utf16le");
	expect(plain.endsWith("Password")).toBe(true);
	return plain.slice(0, -"Password".length);
}

describe("iso-install build: happy path", () => {
	it("runs media, vm, install, steps, offline, verify-offline, seal, template in order", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		expect(m.os).toBe("windows");
		expect(m.pveVmid).toBe(598);
		expect(m.vmName).toBe("sbx-tpl-winbuild-20261030-1");

		expectInOrder(s.log, [
			"node:media.sha256",
			"virtio:fetch 0.1.271",
			"api:GET /nodes/pve/storage/local/content",
			"api:UPLOAD /nodes/pve/storage/local/upload",
			"iso:make SBXBUILD",
			"api:UPLOAD /nodes/pve/storage/local/upload",
			"iso:make SBXOFFL",
			"api:UPLOAD /nodes/pve/storage/local/upload",
			"api:GET /nodes/pve/capabilities/qemu/machines",
			"api:POST /nodes/pve/qemu",
			`api:PUT ${vm}/config`,
			`api:PUT ${vm}/firewall/options`,
			`api:POST ${vm}/firewall/ipset/ipfilter-net0`,
			"ram:reserve 598 4096",
			`api:POST ${vm}/status/start`,
			`api:PUT ${vm}/sendkey`,
			"guest:step 00-base",
			"guest:reboot",
			`api:PUT ${vm}/config`,
			`api:GET ${vm}/agent/network-get-interfaces`,
			"guest:step 10-system",
			"guest:facts",
			"guest:mkdir-sbx-template",
			`qga:write ${BUILD_JSON}`,
			"guest:step 90-cleanup",
			// offline: the CD swapped on the running Windows (not sealed yet), a one-time boot
			// entry for WinPE from a ramdisk, a reboot into it; WinPE powers off
			`api:PUT ${vm}/config`,
			"guest:pe-setup",
			"guest:reboot",
			// verify-offline: the disk boots, the log and the services are read, the entry goes
			`api:PUT ${vm}/config`,
			`api:POST ${vm}/status/start`,
			"guest:check-offline",
			"guest:pe-cleanup",
			`qga:write ${BUILD_JSON}`,
			// seal
			"guest:rm-sbx-build",
			"guest:seal",
			"guest:sysprep",
			"ram:release 598",
			`api:PUT ${vm}/config`,
			`api:POST ${vm}/template`,
			"node:media.remove",
			"node:lv.tagTemplate",
			"node:lv.usage",
			"verify",
		]);
		expect(s.node.calls.find((c) => c.op === "lv.tagTemplate")?.args).toEqual({
			vmid: 598,
		});
		expect(s.guest.started).toEqual(["00-base", "10-system", "90-cleanup"]);

		// Boot-from-CD key presses: four per second for 60 s at install only. The offline stage
		// neither starts the VM nor presses keys, and Windows is not shut down before it.
		const starts = s.log
			.map((e, i) => (e === `api:POST ${vm}/status/start` ? i : -1))
			.filter((i) => i >= 0);
		expect(starts).toHaveLength(2);
		const firstStep = s.log.indexOf("guest:step 00-base");
		expect(keysBetween(s.log, starts[0] ?? 0, firstStep)).toBe(240);
		expect(keysBetween(s.log, firstStep, s.log.length)).toBe(0);
		const offline = s.log.indexOf("guest:step 90-cleanup");
		expect(
			s.log.slice(offline, starts[1]).includes(`api:POST ${vm}/agent/shutdown`),
		).toBe(false);
		// The disk boots once after WinPE, before sysprep.
		expect(s.log.indexOf("guest:sysprep")).toBeGreaterThan(starts[1] ?? 0);
		for (const c of s.pve.calls.filter((c) => c.path === `${vm}/sendkey`))
			expect(c.params).toEqual({ key: "f12" });
	});

	it("creates the build VM with firmware disks, three CDs and the network down", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		const create = s.pve.calls.find(
			(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
		);
		expect(create?.params).toMatchObject({
			vmid: 598,
			name: "sbx-tpl-winbuild-20261030-1",
			pool: "sandbox",
			machine: "pc-q35-11.0+pve2",
			cpu: "host",
			bios: "ovmf",
			ostype: "win11",
			scsihw: "virtio-scsi-single",
			agent: "enabled=1",
			tablet: "1",
			cores: 4,
			memory: 4096,
			balloon: 0,
			efidisk0: "local-lvm:1,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k",
			tpmstate0: "local-lvm:1,version=v2.0",
			scsi0: "local-lvm:96,discard=on,iothread=1,ssd=1",
			net0: "virtio=02:01:00:00:02:56,bridge=sbx0,firewall=1,link_down=1",
			ide2: `local:iso/${USER_ISO},media=cdrom`,
			sata1: `local:iso/${VIRTIO_ISO},media=cdrom`,
			sata2: `local:iso/${buildIso(m)},media=cdrom`,
			boot: "order=scsi0;ide2",
		});
		for (const k of ["smbios1", "vmstatestorage", "tags", "cloudinit"])
			expect(create?.params).not.toHaveProperty(k);
		expect(String(create?.params?.description)).toContain(m.buildId);
		// No resize: the disk is allocated with its size.
		expect(s.pve.calls.some((c) => c.path === `${vm}/resize`)).toBe(false);
	});

	it("swaps the CD for the offline boot, boots the disk again, starts sysprep without waiting and cleans up the template config", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(s.sysprepCalls).toEqual([SYSPREP]);
		const sealCmd = s.guest.calls.find((c) => c.cmd[1] === "seal")?.cmd;
		expect(sealCmd).toEqual([
			"C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe",
			"seal",
		]);

		const puts = s.pve.calls.filter(
			(c) => c.method === "PUT" && c.path === `${vm}/config`,
		);
		expect(puts.map((c) => c.params)).toEqual([
			{ tags: "sbx-tpl" },
			{
				net0: "virtio=02:01:00:00:02:56,bridge=sbx0,firewall=1,link_down=0",
			},
			{ sata2: `local:iso/${offlineIso(m)},media=cdrom` },
			{ sata2: "none,media=cdrom", boot: "order=scsi0" },
			{
				delete: "ide2,sata1,sata2",
				boot: "order=scsi0",
				net0: "virtio=02:01:00:00:02:56,bridge=sbx0,firewall=1",
			},
		]);
		const cfg = s.pve.vms.get(598)?.config ?? {};
		expect(cfg.template).toBe("1");
		for (const k of ["ide2", "sata1", "sata2"]) expect(cfg[k]).toBeUndefined();
		expect(cfg.scsi0).toBe(
			"local-lvm:base-598-disk-1,discard=on,iothread=1,ssd=1",
		);
		expect(s.pve.vms.get(598)?.firewall.ipsets).toEqual({});
		expect((await s.allocator.get(598))?.state).toBe("active");
	});

	it("uploads virtio-win once per version and removes only the build and offline ISOs", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(s.pve.uploads.map((u) => [u.file.name, u.fields.content])).toEqual([
			[VIRTIO_ISO, "iso"],
			[buildIso(m), "iso"],
			[offlineIso(m), "iso"],
		]);
		expect(s.pve.uploads[0]?.fields.checksum).toBe(VIRTIO_SHA);
		const removed = s.node.calls.filter((c) => c.op === "media.remove");
		expect(removed.map((c) => c.args)).toEqual([
			{ names: [buildIso(m), offlineIso(m)] },
		]);
		expect(s.node.calls.find((c) => c.op === "media.sha256")?.args).toEqual({
			name: USER_ISO,
		});
		// Local copies of the ISOs are gone too (the build ISO holds the password).
		for (const iso of s.isos) expect(existsSync(iso.out)).toBe(false);

		// A second build finds virtio-win with the same size and skips the upload.
		const again = setup();
		again.pve.storage.push({
			volid: `local:iso/${VIRTIO_ISO}`,
			content: "iso",
			size: readFileSync(join(s.work, "virtio-win-0.1.271.iso")).length,
		});
		const m2 = await buildTemplate(again.deps, again.opts);
		expect(again.pve.uploads.map((u) => u.file.name)).toEqual([
			buildIso(m2),
			offlineIso(m2),
		]);
	});

	it("records the Windows facts, the pinned machine and all three disks in the manifest", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.windows).toEqual({
			edition: "Windows 11 Pro",
			editionId: "Professional",
			build: "26300",
			ubr: 9457,
			displayVersion: "26H1",
			family: "client",
			isoFile: USER_ISO,
			isoSha256: ISO_SHA,
			virtioWinVersion: "0.1.271",
			openssh: { source: "inbox", version: "9.8.3.1" },
			appxRemoved: ["Microsoft.BingNews", "Clipchamp.Clipchamp"],
			options: { vsBuildtools: false },
			offline: {
				services: [
					"WinDefend",
					"WdNisSvc",
					"Sense",
					"WdBoot",
					"WdFilter",
					"WdNisDrv",
					"WaaSMedicSvc",
				],
				missing: [],
				log: "DONE errors 0",
			},
		});
		expect(m.license).toEqual({
			status: null,
			channel: "retail",
			daysRemaining: null,
			expiresAt: null,
		});
		expect(m.tools).toEqual(FAKE_WIN_FACTS.tools);
		expect(m.hw).toMatchObject({
			machine: "pc-q35-11.0+pve2",
			bios: "ovmf",
			cloudinit: false,
		});
		expect(m.diskLayout).toEqual({
			efidisk0: {
				index: "0",
				efitype: "4m",
				"pre-enrolled-keys": "1",
				"ms-cert": "2023k",
			},
			scsi0: {
				index: "1",
				size: "96G",
				discard: "on",
				iothread: "1",
				ssd: "1",
			},
			tpmstate0: { index: "2", version: "v2.0" },
		});
		expect(m.diskUsedGiB).toBe(12);
		expect(m.buildMemoryMb).toBe(4096);
		expect(m).not.toHaveProperty("base");
		expect(m).not.toHaveProperty("apt");

		const inGuest = JSON.parse(
			String(s.files.files.get(BUILD_JSON)?.toString("utf8")),
		);
		expect(inGuest).not.toHaveProperty("verify");
		expect(inGuest).toMatchObject({
			buildId: m.buildId,
			os: "windows",
			pveVmid: 598,
			windows: { build: "26300", ubr: 9457, offline: m.windows?.offline },
		});
	});

	it("records the services the offline stage disabled, checked on the next boot", async () => {
		const s = setup();
		s.guest.serviceStart = { Sense: null };
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.windows?.offline).toEqual({
			services: [
				"WinDefend",
				"WdNisSvc",
				"WdBoot",
				"WdFilter",
				"WdNisDrv",
				"WaaSMedicSvc",
			],
			missing: ["Sense"],
			log: "DONE errors 0",
		});
		// dmwappushservice must stay alive through sysprep /generalize: not in the offline set.
		const check = s.guest.calls.find((c) =>
			Buffer.from(String(c.cmd.at(-1)), "base64")
				.toString("utf16le")
				.includes("sbx-offline.log"),
		);
		expect(
			Buffer.from(String(check?.cmd.at(-1)), "base64").toString("utf16le"),
		).not.toContain("dmwappushservice");
	});

	it("keeps the build password in the build ISO only", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		const iso = s.isos.find((i) => i.label === "SBXBUILD");
		expect(iso).toBeDefined();
		const password = buildPassword(iso?.files ?? new Map());
		expect(password.length).toBeGreaterThanOrEqual(16);
		const registryText = readdirSync(s.registry.dir)
			.map((f) => readFileSync(join(s.registry.dir, f), "utf8"))
			.join("\n");
		for (const text of [
			JSON.stringify(m),
			registryText,
			s.messages.join("\n"),
			s.log.join("\n"),
			JSON.stringify(s.pve.calls),
			JSON.stringify(s.node.calls),
			JSON.stringify(s.guest.calls),
			String(s.files.files.get(BUILD_JSON)),
		])
			expect(text).not.toContain(password);
		// A new password per build.
		const other = setup();
		await buildTemplate(other.deps, other.opts);
		const second = other.isos.find((i) => i.label === "SBXBUILD");
		expect(buildPassword(second?.files ?? new Map())).not.toBe(password);
	});

	it("puts the agent package and the generic key into the build ISO, a key file overrides it", async () => {
		const s = setup();
		await buildTemplate(s.deps, s.opts);
		const files = s.isos.find((i) => i.label === "SBXBUILD")?.files;
		expect(files?.get("build/sbx-agent-0.4.0-test-windows-amd64.tar")).toEqual(
			readFileSync(s.opts.agentPackage),
		);
		expect(String(files?.get("autounattend.xml"))).toContain(
			"<Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key>",
		);
		const agentToml = String(files?.get("build/agent.toml"));
		expect(agentToml).toContain('default = "user"');
		expect(agentToml).toContain("enabled = false");

		const k = setup();
		const keyFile = join(k.work, "product.key");
		writeFileSync(keyFile, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY\n");
		const m = await buildTemplate(k.deps, {
			...k.opts,
			productKeyFile: keyFile,
		});
		const xml = String(
			k.isos.find((i) => i.label === "SBXBUILD")?.files.get("autounattend.xml"),
		);
		expect(xml).toContain("<Key>ABCDE-FGHIJ-KLMNO-PQRST-UVWXY</Key>");
		// The offline boot installs nothing: it gets the generic key, never the real one.
		for (const b of [s, k]) {
			const off = String(
				b.isos
					.find((i) => i.label === "SBXOFFL")
					?.files.get("autounattend.xml"),
			);
			expect(off).toContain("<Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key>");
			expect(off).toContain("<UILanguage>en-GB</UILanguage>");
			expect(off).not.toContain("ABCDE-FGHIJ");
		}
		expect(JSON.stringify(m)).not.toContain("ABCDE-FGHIJ");
		expect(k.messages.join("\n")).not.toContain("ABCDE-FGHIJ");
	});

	it("--iso and --edition override the pinned ISO for one build", async () => {
		const s = setup({
			iso: "Win11_25H2_EnglishInternational_x64.iso",
			isoSha256: ISO_SHA,
		});
		const m = await buildTemplate(s.deps, {
			...s.opts,
			edition: "Windows 11 Enterprise",
		});
		expect(m.windows?.isoFile).toBe("Win11_25H2_EnglishInternational_x64.iso");
		expect(m.windows?.edition).toBe("Windows 11 Enterprise");
		const create = s.pve.calls.find(
			(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
		);
		expect(create?.params?.ide2).toBe(
			"local:iso/Win11_25H2_EnglishInternational_x64.iso,media=cdrom",
		);
		const xml = String(
			s.isos.find((i) => i.label === "SBXBUILD")?.files.get("autounattend.xml"),
		);
		expect(xml).toContain("Windows 11 Enterprise");
	});
});

describe("step timeouts", () => {
	it("step_timeouts of the recipe in minutes, the runner's default for the rest", () => {
		const r = loadRecipe(
			join(repoRoot, "infra/templates"),
			"windows",
			"windows",
		);
		expect(stepTimeoutMs(r, "30-toolchains")).toBe(60 * 60_000);
		expect(stepTimeoutMs(r, "40-coding-agents")).toBe(45 * 60_000);
		expect(stepTimeoutMs(r, "90-cleanup")).toBe(120 * 60_000);
		expect(stepTimeoutMs(r, "00-base")).toBeUndefined();
	});
});

describe("iso-install build: user ISO", () => {
	it("ISO sha mismatch fails before any VM", async () => {
		const s = setup();
		s.state.isoSha = "cd".repeat(32);
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("media");
		expect(m.error?.message).toContain("cd".repeat(32));
		expect(m.error?.message).toContain(ISO_SHA);
		expect(s.pve.uploads).toEqual([]);
		expect(s.pve.calls.some((c) => c.path.startsWith("/nodes/pve/qemu"))).toBe(
			false,
		);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("another --iso needs its own sha256", async () => {
		const s = setup({ iso: "Win11_25H2_EnglishInternational_x64.iso" });
		await expect(buildTemplate(s.deps, s.opts)).rejects.toThrow(/not pinned/);
	});

	it("--iso-sha256 replaces the pinned value for one build", async () => {
		const s = setup({ isoSha256: "cd".repeat(32) });
		s.state.isoSha = "cd".repeat(32);
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.windows?.isoSha256).toBe("cd".repeat(32));
		expect(
			readFileSync(join(s.templatesDir, "winbuild/versions.toml"), "utf8"),
		).toContain(`sha256 = "${ISO_SHA}"`);
	});

	it("an unknown ISO sha256 is refused before the build is recorded", async () => {
		const s = setup({}, { pinnedSha: "" });
		await expect(buildTemplate(s.deps, s.opts)).rejects.toThrow(
			/--accept-iso-sha256/,
		);
		expect(s.registry.list()).toEqual([]);
		expect(s.node.calls).toEqual([]);
	});

	it("--accept-iso-sha256 writes versions.toml", async () => {
		const s = setup({ acceptIsoSha256: true }, { pinnedSha: "" });
		s.state.isoSha = "ef".repeat(32);
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.windows?.isoSha256).toBe("ef".repeat(32));
		const text = readFileSync(
			join(s.templatesDir, "winbuild/versions.toml"),
			"utf8",
		);
		expect(text).toContain(`sha256 = "${"ef".repeat(32)}"`);
		// Only the [iso] value changed: virtio-win and the tools keep theirs.
		expect(text).toContain(`sha256 = "${VIRTIO_SHA}"`);
		expect(text.split("\n")[0]).toMatch(/^# /);
		expect(s.messages.join("\n")).toContain("ef".repeat(32));
	});

	it("--accept-iso-sha256 records the recipe digest of the rewritten versions.toml", async () => {
		const s = setup({ acceptIsoSha256: true }, { pinnedSha: "" });
		s.state.isoSha = "ef".repeat(32);
		const m = await buildTemplate(s.deps, s.opts);
		const now = recipeDigest(loadRecipe(s.templatesDir, "winbuild"));
		expect(m.recipeDigest).toBe(now);
		expect(
			s.registry.list().find((x) => x.buildId === m.buildId)?.recipeDigest,
		).toBe(now);
	});

	it("a missing user ISO fails the media stage with a hint", async () => {
		const s = setup();
		s.node.handlers["media.sha256"] = () => {
			throw new Error(`not_found: ${USER_ISO}`);
		};
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("media");
		expect(m.error?.message).toMatch(/iso upload/);
	});
});

describe("iso-install build: failures", () => {
	it("failing step rolls back VM, build+offline ISOs, lease; user ISO untouched", async () => {
		const s = setup();
		s.guest.failRc["10-system"] = "3";
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error).toMatchObject({
			stage: "steps",
			step: "10-system",
			tail: ["running 10-system", "end of 10-system"],
		});
		expect(s.guest.started).toEqual(["00-base", "10-system"]);
		expectInOrder(s.log, [
			`api:POST ${vm}/status/stop`,
			`api:DELETE ${vm}`,
			"node:media.remove",
			"ram:release 598",
		]);
		const removed = s.node.calls.filter((c) => c.op === "media.remove");
		expect(removed.map((c) => c.args)).toEqual([
			{ names: [buildIso(m), offlineIso(m)] },
		]);
		const names = removed.flatMap((c) => c.args.names as string[]);
		expect(names).not.toContain(USER_ISO);
		expect(names).not.toContain(VIRTIO_ISO);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("--fail-step replaces the step script in the build ISO", async () => {
		const s = setup({ failStep: "10-system" });
		await buildTemplate(s.deps, s.opts).catch(() => {});
		const files = s.isos.find((i) => i.label === "SBXBUILD")?.files;
		expect(String(files?.get("build/steps/10-system.ps1"))).toContain("exit 1");
		expect(String(files?.get("build/steps/00-base.ps1"))).not.toContain(
			"--fail-step",
		);
	});

	it("a failed upload of the build ISO still removes it", async () => {
		const s = setup();
		s.pve.before = (method, _path, params) => {
			if (
				method === "UPLOAD" &&
				String(params?.content) === "iso" &&
				s.log.includes("iso:make SBXBUILD")
			)
				throw new PveApiError(500, "upload failed");
		};
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("media");
		expect(
			s.node.calls.filter((c) => c.op === "media.remove").map((c) => c.args),
		).toEqual([{ names: [buildIso(m)] }]);
		for (const iso of s.isos) expect(existsSync(iso.out)).toBe(false);
	});

	it("a guest agent that never answers fails the install with a hint", async () => {
		const s = setup();
		s.guest.alive = () => false;
		s.opts.templatesDir = s.templatesDir;
		writeFileSync(
			join(s.templatesDir, "winbuild/template.yaml"),
			RECIPE.replace("install_timeout_s: 2400", "install_timeout_s: 1"),
		);
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("install");
		expect(m.error?.message).toMatch(/edition|keep-on-failure/);
		expect(s.pve.vms.has(598)).toBe(false);
	});

	it("keys refused while the start task runs do not end the presses", async () => {
		const s = setup();
		// QEMU is not up until the start task ends; the task takes a while on a slow uplink.
		let starting = false;
		const api = s.deps.api;
		const waitTask = api.waitTask.bind(api);
		api.waitTask = async (n, u, o) => {
			await new Promise((r) => setTimeout(r, 20));
			starting = false;
			return waitTask(n, u, o);
		};
		const base = s.pve.before;
		s.pve.before = (method, path, params) => {
			base?.(method, path, params);
			if (method === "POST" && path === `${vm}/status/start`) starting = true;
			if (method === "PUT" && path === `${vm}/sendkey` && starting)
				throw new Error(`PUT ${vm}/sendkey: VM 598 not running`);
		};
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
	});

	it("the offline stage sets a one-time BCD ramdisk entry for WinPE, verify-offline removes it", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		const scripts = s.guest.calls
			.filter((c) => c.cmd.includes("-EncodedCommand"))
			.map((c) =>
				Buffer.from(String(c.cmd.at(-1)), "base64").toString("utf16le"),
			);
		const pe = scripts.find((t) => t.includes("/bootsequence")) ?? "";
		for (const want of [
			"sources\\boot.wim",
			"boot\\boot.sdi",
			"'C:\\sbx-pe'",
			"'/create', '{ramdiskoptions}', '/d', 'sbx offline'",
			"'ramdisksdidevice', 'partition=C:'",
			"'ramdisksdipath', '\\sbx-pe\\boot.sdi'",
			"'/create', '/d', 'sbx offline', '/application', 'osloader'",
			"'ramdisk=[C:]\\sbx-pe\\boot.wim,{ramdiskoptions}'",
			"'device', $dev",
			"'osdevice', $dev",
			"'path', '\\windows\\system32\\boot\\winload.efi'",
			"'systemroot', '\\windows'",
			"'winpe', 'yes'",
			"'detecthal', 'yes'",
			"'/bootsequence', $id",
			"$LASTEXITCODE -ne 0",
		])
			expect(pe).toContain(want);
		const cleanup =
			scripts.find(
				(t) => t.includes("C:\\sbx-pe") && !t.includes("/bootsequence"),
			) ?? "";
		expect(cleanup).toContain("'/delete'");
		expect(cleanup).toContain("'/enum', 'all', '/v'");
		expect(cleanup).toContain("sbx offline");
		expect(cleanup).toContain("Remove-Item -LiteralPath 'C:\\sbx-pe'");
		// The reboot goes through the guest (the reboot step is the other one).
		expect(s.log.filter((e) => e === "guest:reboot")).toHaveLength(2);
		expect(s.messages.join("\n")).toContain(
			"{6a7c3b1e-0d2f-11f1-9a3c-525400a1b2c3}",
		);
		// The boot order stays on the disk: Windows Boot Manager starts WinPE.
		expect(
			s.pve.calls.some(
				(c) =>
					c.method === "PUT" &&
					c.path === `${vm}/config` &&
					String(c.params?.boot ?? "").includes("ide2"),
			),
		).toBe(false);
	});

	it("Windows booting instead of WinPE is detected and the entry set once more", async () => {
		const s = setup();
		s.state.peIgnored = 1;
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		expectInOrder(s.log, [
			"guest:step 90-cleanup",
			"guest:pe-setup",
			"guest:reboot",
			"guest:pe-setup",
			"guest:reboot",
			"guest:check-offline",
			"guest:sysprep",
		]);
		expect(s.log.filter((e) => e === "guest:pe-setup")).toHaveLength(2);
		expect(s.messages.join("\n")).toMatch(
			/offline attempt 1 of 2: .*Windows booted/,
		);
	});

	it("Windows booting again after every reboot fails the offline stage before sysprep", async () => {
		const s = setup();
		s.state.peIgnored = 1000;
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("offline");
		expect(m.error?.message).toMatch(/bootsequence/);
		expect(m.error?.message).toMatch(/2 attempts/);
		expect(s.log.filter((e) => e === "guest:pe-setup")).toHaveLength(2);
		expect(s.log).not.toContain("guest:seal");
		expect(s.log).not.toContain("guest:sysprep");
		expect(s.log).not.toContain(`api:POST ${vm}/template`);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(
			s.node.calls.filter((c) => c.op === "media.remove").map((c) => c.args),
		).toEqual([{ names: [buildIso(m), offlineIso(m)] }]);
	});

	it("a CD change the running VM refuses or leaves pending falls back to a shutdown and a boot into Windows", async () => {
		const offlineCd = (params: Record<string, unknown> | undefined) =>
			String(params?.sata2 ?? "").includes("sbx-offline");
		const refused = (s: ReturnType<typeof setup>) => {
			const base = s.pve.before;
			s.pve.before = (method, path, params) => {
				base?.(method, path, params);
				if (
					method === "PUT" &&
					path === `${vm}/config` &&
					offlineCd(params) &&
					s.pve.vms.get(598)?.status === "running"
				)
					throw new PveApiError(500, "hotplug problem - cdrom change refused");
			};
		};
		const pending = (s: ReturnType<typeof setup>) => {
			const api = s.deps.api;
			const put = api.put.bind(api);
			api.put = async <T>(path: string, params?: Parameters<typeof put>[1]) => {
				const v = s.pve.vms.get(598);
				const was = v?.config.sata2;
				const r = await put<T>(path, params);
				// The change waits in the pending section until the VM stops.
				if (v && offlineCd(params) && v.status === "running" && was)
					v.config.sata2 = was;
				return r;
			};
		};
		for (const arrange of [refused, pending]) {
			const s = setup();
			arrange(s);
			const m = await buildTemplate(s.deps, s.opts);
			expect(m.status).toBe("ready");
			expectInOrder(s.log, [
				"guest:step 90-cleanup",
				`api:POST ${vm}/agent/shutdown`,
				`api:PUT ${vm}/config`,
				`api:POST ${vm}/status/start`,
				"guest:pe-setup",
				"guest:reboot",
				"guest:check-offline",
			]);
			expect(s.messages.join("\n")).toMatch(
				arrange === refused
					? /offline ISO on sata2 .*cdrom change refused/
					: /offline ISO on sata2 .*pending/,
			);
		}
	});

	it("a failing bcdedit fails the offline stage with its output, before any reboot", async () => {
		const s = setup();
		s.guest.peSetupExit = 1;
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("offline");
		expect(m.error?.message).toMatch(/bcdedit \/create failed/);
		// Only the reboot step rebooted.
		expect(s.log.filter((e) => e === "guest:reboot")).toHaveLength(1);
		expect(s.log).not.toContain("guest:sysprep");
	});

	it("a WinPE that never powers off fails the offline stage after its timeout", async () => {
		const s = setup();
		s.state.offlineStopsAfter = 1_000_000;
		s.deps.offlineTimeoutMs = 30;
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("offline");
		expect(m.error?.message).toMatch(/did not power off within 30 ms/);
		expect(s.log).not.toContain("guest:sysprep");
	});

	it("a WinPE boot entry left after the cleanup fails verify-offline", async () => {
		const s = setup();
		s.guest.peCleanupExit = 1;
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("verify-offline");
		expect(m.error?.message).toMatch(/sbx offline/);
		expect(s.log).not.toContain("guest:seal");
		expect(s.log).not.toContain("guest:sysprep");
	});

	it("an offline log with errors fails verify-offline with its tail, before sysprep", async () => {
		const s = setup();
		s.guest.offlineLog =
			"sbx offline stage: drivers w11\r\nWindows volume C:\r\nERROR reg load of the offline SYSTEM hive failed\r\nDONE errors 1\r\n";
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("verify-offline");
		expect(m.error?.message).toMatch(/DONE errors 1/);
		expect(m.error?.tail).toEqual([
			"sbx offline stage: drivers w11",
			"Windows volume C:",
			"ERROR reg load of the offline SYSTEM hive failed",
			"DONE errors 1",
		]);
		expect(s.log).not.toContain("guest:seal");
		expect(s.log).not.toContain("guest:sysprep");
		expect(s.pve.vms.has(598)).toBe(false);
	});

	it("a missing offline log, a service left enabled or a running MsMpEng fail verify-offline", async () => {
		const cases: [(s: ReturnType<typeof setup>) => void, RegExp][] = [
			[
				(s) => {
					s.guest.offlineLog = null;
				},
				/sbx-offline\.log is missing/,
			],
			[
				(s) => {
					s.guest.offlineLog = "sbx offline stage\r\nOK x\r\n";
				},
				/no "DONE errors 0"/,
			],
			[
				(s) => {
					s.guest.serviceStart = { WinDefend: 3, WaaSMedicSvc: 2 };
				},
				/WinDefend Start=3, WaaSMedicSvc Start=2/,
			],
			[
				(s) => {
					s.guest.msMpEng = true;
				},
				/MsMpEng is running/,
			],
		];
		for (const [arrange, message] of cases) {
			const s = setup();
			arrange(s);
			const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
			expect(m.error?.stage).toBe("verify-offline");
			expect(m.error?.message).toMatch(message);
			expect(s.log).not.toContain("guest:sysprep");
		}
	});

	it("a template without net0 fails the template stage instead of writing an empty net0", async () => {
		const s = setup();
		const base = s.pve.before;
		s.pve.before = (method, path, params) => {
			base?.(method, path, params);
			if (
				method === "GET" &&
				path === `${vm}/config` &&
				s.log.includes("ram:release 598")
			)
				delete s.pve.vms.get(598)?.config.net0;
		};
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("template");
		expect(m.error?.message).toMatch(/net0/);
		expect(
			s.pve.calls.some(
				(c) =>
					c.method === "PUT" &&
					c.path === `${vm}/config` &&
					c.params?.net0 === "",
			),
		).toBe(false);
		expect(s.log).not.toContain(`api:POST ${vm}/template`);
	});

	it("a media.remove failure after the template keeps the finished template", async () => {
		const s = setup();
		s.node.handlers["media.remove"] = () => {
			throw new Error("node unreachable");
		};
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		expect(s.pve.vms.get(598)?.config.template).toBe("1");
		expect((await s.allocator.get(598))?.state).toBe("active");
		expect(s.messages.join("\n")).toMatch(/sbx-tpl cleanup/);
	});

	it("a C:\\sbx-build that resists removal is retried, then only warned about", async () => {
		const s = setup();
		s.guest.rmBuildDirExits = [1, 1];
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		expect(s.log.filter((e) => e === "guest:rm-sbx-build")).toHaveLength(3);
		expect(s.messages.join("\n")).not.toMatch(
			/WARNING: removing C:\\sbx-build/,
		);

		const w = setup();
		w.guest.rmBuildDirExits = Array.from({ length: 10 }, () => 1);
		const m2 = await buildTemplate(w.deps, w.opts);
		expect(m2.status).toBe("ready");
		expect(w.log.filter((e) => e === "guest:rm-sbx-build")).toHaveLength(5);
		expect(w.messages.join("\n")).toMatch(
			/WARNING: removing C:\\sbx-build failed .*file in use/,
		);
		expectInOrder(w.log, ["guest:rm-sbx-build", "guest:seal", "guest:sysprep"]);
	});

	it("sysprep failure surfaces setuperr tail", async () => {
		const s = setup();
		s.state.sysprepResult = { exitcode: 1 };
		s.state.sysprepStopsAfter = undefined;
		s.guest.setupErr = Array.from(
			{ length: 60 },
			(_, i) =>
				`2026-10-31 10:00:${String(i).padStart(2, "0")}, Error SYSPRP line ${i}`,
		).join("\r\n");
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("seal");
		expect(m.error?.message).toMatch(/sysprep/);
		expect(m.error?.tail).toHaveLength(50);
		expect(m.error?.tail?.[0]).toContain("line 10");
		expect(m.error?.tail?.at(-1)).toContain("line 59");
		expect(s.pve.vms.has(598)).toBe(false);
	});

	it("a sysprep that never powers the VM off fails after its timeout", async () => {
		const s = setup();
		s.state.sysprepStopsAfter = undefined;
		s.deps.sysprepTimeoutMs = 20;
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("seal");
		expect(m.error?.message).toMatch(/did not power off/);
	});

	it("keepOnFailure keeps the VM and the offline ISO but ejects and removes the build ISO", async () => {
		const s = setup({ keepOnFailure: true });
		s.guest.failRc["10-system"] = "1";
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(s.pve.vms.get(598)?.status).toBe("running");
		expect(s.pve.vms.get(598)?.config.sata2).toBe("none,media=cdrom");
		expect(
			s.node.calls.filter((c) => c.op === "media.remove").map((c) => c.args),
		).toEqual([{ names: [buildIso(m)] }]);
		expect((await s.allocator.get(598))?.state).toBe("reserved");
	});

	it("keepOnFailure leaves a VM that is not this build's untouched", async () => {
		const s = setup({ keepOnFailure: true });
		s.guest.failRc["10-system"] = "1";
		const base = s.pve.before;
		s.pve.before = (method, path, params) => {
			base?.(method, path, params);
			if (
				method === "GET" &&
				path === `${vm}/config` &&
				s.messages.some((x) => x.startsWith("failed at"))
			) {
				const v = s.pve.vms.get(598);
				if (v) v.config.name = "someone-elses-vm";
			}
		};
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(s.pve.vms.get(598)?.config.sata2).toBe(
			`local:iso/${buildIso(m)},media=cdrom`,
		);
		expect(
			s.pve.calls.some(
				(c) =>
					c.method === "PUT" &&
					c.path === `${vm}/config` &&
					c.params?.sata2 === "none,media=cdrom",
			),
		).toBe(false);
	});

	it("refuses a linux agent package for a windows recipe before recording", async () => {
		const s = setup();
		const linux = writeAgentPackage(s.work, { os: "linux" });
		await expect(
			buildTemplate(s.deps, {
				...s.opts,
				agentPackage: linux.tar,
				updateKeysFile: linux.keys,
			}),
		).rejects.toThrow(/windows\/amd64/);
		expect(s.registry.list()).toEqual([]);
	});

	it("rejects linux-only and bad options before recording", async () => {
		for (const over of [
			{ sbxCli: "/bin/sh" },
			{ failStep: "reboot" },
			{ failStep: "network-up" },
			{ iso: "../evil.iso" },
			{ isoSha256: "XYZ" },
			{ isoSha256: ISO_SHA, acceptIsoSha256: true },
		] as Partial<BuildOptions>[]) {
			const s = setup(over);
			await expect(buildTemplate(s.deps, s.opts)).rejects.toThrow();
			expect(s.registry.list()).toEqual([]);
		}
		const k = setup();
		const bad = join(k.work, "bad.key");
		writeFileSync(bad, "not a key\n");
		await expect(
			buildTemplate(k.deps, { ...k.opts, productKeyFile: bad }),
		).rejects.toThrow(/product key/);
	});

	it("a linux recipe refuses the Windows-only options", async () => {
		const s = setup({
			slug: "linux",
			templatesDir: join(repoRoot, "infra/templates"),
		});
		await expect(
			buildTemplate(s.deps, { ...s.opts, iso: USER_ISO }),
		).rejects.toThrow(/--iso/);
	});

	it("the licence verify reads goes to the manifest", async () => {
		const s = setup();
		const license = {
			status: "Licensed",
			channel: "retail" as const,
			daysRemaining: null,
			expiresAt: null,
		};
		s.setVerify({ ...VERIFY_OK, license });
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.license).toEqual(license);
		expect(m.verify?.license).toEqual(license);
	});

	it("a red verify deletes the template and removes nothing else", async () => {
		const s = setup();
		s.setVerify({ ...VERIFY_OK, ok: false });
		const m = failed(await buildTemplate(s.deps, s.opts).catch((e) => e));
		expect(m.error?.stage).toBe("verify");
		expect(s.pve.vms.has(598)).toBe(false);
		// The ISOs went in the template stage already.
		expect(s.node.calls.filter((c) => c.op === "media.remove")).toHaveLength(1);
	});
});
