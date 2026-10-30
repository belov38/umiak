import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Allocator, PveApiError, SqliteStateStore } from "@sbx/pve";
import { FakeNode } from "@sbx/pve/testing";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	type BuildDeps,
	BuildFailedError,
	type BuildOptions,
	buildTemplate,
	FAIL_STEP_SCRIPT,
	registerCommand,
	topologySnippet,
} from "../src/build.ts";
import { pveImageName } from "../src/image.ts";
import type { Manifest, VerifyResult } from "../src/manifest.ts";
import { loadRecipe, loadVersions } from "../src/recipe.ts";
import { FileRegistry } from "../src/registry.ts";
import { BuildPve, FakeGuest } from "./fakes.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const templatesDir = join(repoRoot, "infra/templates");
const agentFixtures = resolve(import.meta.dirname, "fixtures/agent");
const SERIAL = loadVersions(loadRecipe(templatesDir, "linux")).base.serial;
const IMAGE_NAME = pveImageName(SERIAL);
const STEPS = [
	"00-base",
	"10-system",
	"20-docker",
	"30-toolchains",
	"40-coding-agents",
	"50-sbx-agent",
	"90-cleanup",
];

const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "sbx-build-test-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VERIFY_OK: VerifyResult = {
	ok: true,
	checks: [{ id: "os", status: "PASS", evidence: "VERSION_ID=26.04" }],
	boot: {
		first: { startToQgaMs: 9000, startToIpMs: 9500 },
		hardRestart: { startToQgaMs: 9100, startToIpMs: 9600 },
	},
	kvm: { available: true },
	fork: { ok: true },
	at: "2026-10-30T10:30:00.000Z",
};

function setup(
	over: Partial<BuildOptions> = {},
	shared?: { registry: FileRegistry; work: string },
) {
	const work = shared?.work ?? tmp();
	const log: string[] = [];
	const pve = new BuildPve(log);
	const node = new FakeNode(log);
	node.handlers["media.remove"] = (a) => ({
		removed: a.names,
		missing: [],
	});
	const store = new SqliteStateStore(":memory:");
	const allocator = new Allocator({
		store,
		clusterId: 1,
		range: { min: 500, max: 598 },
		templateVmid: 599,
		occupied: async () => new Set(pve.vms.keys()),
	});
	const registry = shared?.registry ?? new FileRegistry(join(work, "registry"));
	const guest = new FakeGuest(log);
	const image = join(work, "image.img");
	writeFileSync(image, "base image bytes");
	const isos: Map<string, string | Buffer>[] = [];
	let verifyResult = VERIFY_OK;
	const verifyCalls: Manifest[] = [];
	let t = Date.parse("2026-10-30T10:00:00Z");
	const deps: BuildDeps = {
		api: pve,
		node,
		allocator,
		registry,
		fetchImage: async (base) => {
			log.push(`image:fetch ${base.serial}`);
			return { path: image, sha256: sha(readFileSync(image)) };
		},
		io: () => guest,
		makeIso: (files, out) => {
			isos.push(files);
			writeFileSync(out, `iso with ${files.size} files`);
			log.push("iso:make");
		},
		verify: async (m) => {
			verifyCalls.push(m);
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
		log: () => {},
		now: () => {
			t += 1000;
			return new Date(t);
		},
		pollMs: 1,
	};
	const opts: BuildOptions = {
		slug: "linux",
		node: "pve",
		storage: "local-lvm",
		pool: "sandbox",
		vnet: "sbx0",
		agentPackage: join(agentFixtures, "sbx-agent-fixture.tar"),
		keepOnFailure: false,
		noVerify: false,
		templatesDir,
		updateKeysFile: join(agentFixtures, "update-keys.pub"),
		gitCommit: "c0ffee",
		...over,
	};
	return {
		work,
		log,
		pve,
		node,
		allocator,
		registry,
		guest,
		image,
		isos,
		verifyCalls,
		deps,
		opts,
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

const seedName = (m: Manifest) => `sbx-seed-${m.buildId}.raw`;
const vm = "/nodes/pve/qemu/598";

describe("buildTemplate: happy path", () => {
	it("runs the stages in order and records a ready build", async () => {
		const s = setup({ logDir: join(tmp(), "build-logs") });
		const m = await buildTemplate(s.deps, s.opts);

		expect(m.status).toBe("ready");
		expect(m.version).toBe("20261030.1");
		expect(m.vmName).toBe("sbx-tpl-linux-20261030-1");
		expect(m.pveVmid).toBe(598);
		expect(s.registry.get(m.buildId)).toEqual(m);

		expectInOrder(s.log, [
			`image:fetch ${SERIAL}`,
			"api:GET /nodes/pve/storage/local/content",
			"api:UPLOAD /nodes/pve/storage/local/upload",
			"iso:make",
			"api:UPLOAD /nodes/pve/storage/local/upload",
			"api:POST /nodes/pve/qemu",
			`api:PUT ${vm}/resize`,
			`api:PUT ${vm}/firewall/options`,
			`api:POST ${vm}/firewall/ipset/ipfilter-net0`,
			"ram:reserve 598 4096",
			`api:POST ${vm}/status/start`,
			"guest:step 00-base",
			"guest:reboot",
			"guest:step 10-system",
			"guest:step 20-docker",
			"guest:step 30-toolchains",
			"guest:step 40-coding-agents",
			"guest:step 50-sbx-agent",
			"guest:step 90-cleanup",
			"guest:dpkg-query",
			"guest:verify-tools",
			"guest:write /etc/sbx-template/build.json.tmp",
			"guest:mv /etc/sbx-template/build.json",
			"guest:rm-build-logs",
			"guest:random-seed",
			"guest:seal",
			"guest:zero-fill",
			"guest:fstrim",
			"guest:sync",
			`api:POST ${vm}/agent/shutdown`,
			"ram:release 598",
			`api:PUT ${vm}/config`,
			`api:POST ${vm}/template`,
			"node:media.remove",
			"verify",
		]);
		expect(s.guest.started).toEqual(
			STEPS.map((step) => ({
				step,
				script: `/mnt/seed/build/steps/${step}.sh`,
			})),
		);
	});

	it("drops the random seed and the credential secret right before seal and fails if the unit stays active", async () => {
		const s = setup();
		await buildTemplate(s.deps, s.opts);
		const guest = s.log.filter((e) => e.startsWith("guest:"));
		expect(guest[guest.indexOf("guest:seal") - 1]).toBe("guest:random-seed");
		const i = s.guest.calls.findIndex(
			(c) => c.cmd.join(" ") === "sbx-agent seal",
		);
		const cmd = s.guest.calls[i - 1]?.cmd;
		expect(cmd).toEqual([
			"bash",
			"-c",
			// The stop runs ExecStop (which saves a seed) before the files go; any failure stops the build.
			"systemctl stop systemd-random-seed.service && ! systemctl is-active -q systemd-random-seed.service && rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret && sync",
		]);
	});

	it("a failing random seed stop fails the seal stage before seal", async () => {
		const s = setup();
		s.guest.randomSeedExit = 1;
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect((err as BuildFailedError).manifest.error?.stage).toBe("seal");
		expect(s.log).not.toContain("guest:seal");
		expect(s.pve.vms.has(598)).toBe(false);
	});

	it("reports the new build before it starts", async () => {
		const s = setup();
		const seen: Manifest[] = [];
		s.deps.onStart = (m) => {
			seen.push(m);
		};
		const m = await buildTemplate(s.deps, s.opts);
		expect(seen.map((x) => [x.buildId, x.status])).toEqual([
			[m.buildId, "building"],
		]);
	});

	it("creates the build VM with the spec parameters", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		const create = s.pve.calls.find(
			(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
		);
		expect(create?.params).toMatchObject({
			vmid: 598,
			name: "sbx-tpl-linux-20261030-1",
			pool: "sandbox",
			machine: "q35",
			cpu: "host",
			bios: "seabios",
			ostype: "l26",
			scsihw: "virtio-scsi-single",
			agent: "enabled=1",
			serial0: "socket",
			vga: "std",
			tablet: "0",
			rng0: "source=/dev/urandom",
			smbios1: "serial=ZHM9bm9jbG91ZA==,base64=1",
			cores: 4,
			memory: 4096,
			balloon: 0,
			scsi0: `local-lvm:0,import-from=local:import/${IMAGE_NAME},discard=on,iothread=1,ssd=1`,
			scsi1: `local-lvm:0,import-from=local:import/sbx-seed-${m.buildId}.raw`,
			net0: "virtio=02:01:00:00:02:56,bridge=sbx0,firewall=1",
			boot: "order=scsi0",
		});
		for (const k of ["ciuser", "ipconfig0", "cloudinit", "sshkeys"])
			expect(create?.params).not.toHaveProperty(k);
		expect(String(create?.params?.description)).toContain(m.buildId);
		expect(String(create?.params?.description)).toContain("c0ffee");

		const resize = s.pve.calls.find((c) => c.path === `${vm}/resize`);
		expect(resize?.params).toEqual({ disk: "scsi0", size: "64G" });
		const fwOpts = s.pve.calls.find((c) => c.path === `${vm}/firewall/options`);
		expect(fwOpts?.params).toMatchObject({ ipfilter: 1, macfilter: 1 });
		const ipset = s.pve.calls.find(
			(c) => c.path === `${vm}/firewall/ipset/ipfilter-net0`,
		);
		expect(ipset?.params).toEqual({ cidr: "10.88.0.101" });

		const template = s.pve.calls.find(
			(c) =>
				c.method === "PUT" &&
				c.path === `${vm}/config` &&
				c.params?.delete !== undefined,
		);
		expect(template?.params).toEqual({ delete: "smbios1" });
		const unlink = s.pve.calls.find(
			(c) => c.method === "PUT" && c.path === `${vm}/unlink`,
		);
		// force=1: the seed disk is destroyed, not left as unused0.
		expect(unlink?.params).toEqual({ idlist: "scsi1", force: 1 });
		expect(s.pve.vms.get(598)?.config.template).toBe("1");
		expect(s.pve.vms.get(598)?.config.scsi1).toBeUndefined();
		expect(s.pve.vms.get(598)?.config.smbios1).toBeUndefined();
		const removed = s.node.calls.find((c) => c.op === "media.remove");
		expect(removed?.args).toEqual({ names: [seedName(m)] });
		expect((await s.allocator.get(598))?.state).toBe("active");
	});

	it("uploads the base image and the seed image to local:import with sha256 checksums", async () => {
		const s = setup();
		const m = await buildTemplate(s.deps, s.opts);
		expect(s.pve.uploads.map((u) => u.fields)).toEqual([
			{
				content: "import",
				checksum: sha(readFileSync(s.image)),
				"checksum-algorithm": "sha256",
			},
			{
				content: "import",
				checksum: sha(`iso with ${s.isos[0]?.size} files`),
				"checksum-algorithm": "sha256",
			},
		]);
		expect(s.pve.uploads.map((u) => u.file.name)).toEqual([
			IMAGE_NAME,
			seedName(m),
		]);
		// The order pveproxy accepts (see PveApi.upload).
		for (const u of s.pve.uploads)
			expect(Object.keys(u.fields)).toEqual([
				"content",
				"checksum-algorithm",
				"checksum",
			]);
		expect(s.pve.uploads[0]?.file).toMatchObject({
			path: s.image,
			size: statSync(s.image).size,
		});
	});

	it("records the facts of the image in the manifest and in the guest copy", async () => {
		const s = setup({ tunnelUrl: "wss://tunnel.example.test/v1/connect" });
		const m = await buildTemplate(s.deps, s.opts);
		expect(m).toMatchObject({
			templateSlug: "linux",
			os: "linux",
			node: "pve",
			storage: "local-lvm",
			gitCommit: "c0ffee",
			base: {
				distro: "ubuntu",
				release: "26.04",
				flavor: "minimal",
				serial: SERIAL,
			},
			kernel: "7.0.0-10-generic",
			systemd: "systemd 259 (259.1-1ubuntu1)",
			packages: { bash: "5.2.37-1", curl: "8.14.1-1" },
			tools: { node: "v24.11.0", sbx: null },
			agentVersion: "0.0.0-fixture",
			defaultTunnelUrl: "wss://tunnel.example.test/v1/connect",
			hw: { cpu: "host", rng0: "source=/dev/urandom", cloudinit: false },
			diskLayout: {
				scsi0: { size: "64G", discard: "on", iothread: "1", ssd: "1" },
			},
			bootTimeoutS: 300,
			buildMemoryMb: 4096,
			verify: VERIFY_OK,
		});
		expect(m.recipeDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(m.finishedAt).not.toBeNull();
		expect(m.durationS).toBeGreaterThan(0);
		expect(m.error).toBeUndefined();

		const inGuest = JSON.parse(
			String(s.guest.files.get("/etc/sbx-template/build.json")),
		);
		expect(inGuest).not.toHaveProperty("verify");
		expect(inGuest).toMatchObject({
			buildId: m.buildId,
			version: m.version,
			pveVmid: 598,
			packages: m.packages,
			tools: m.tools,
			kernel: m.kernel,
		});
		// The seed carries the first manifest; the agent.toml has the tunnel URL.
		const seed = s.isos[0];
		expect(JSON.parse(String(seed?.get("build/build.json"))).buildId).toBe(
			m.buildId,
		);
		expect(String(seed?.get("build/agent.toml"))).toContain(
			"wss://tunnel.example.test/v1/connect",
		);
		expect(s.verifyCalls[0]?.status).toBe("building");
		expect(s.verifyCalls[0]?.packages).toEqual(m.packages);
	});

	it("passes the facts commands and the verify.sh tools mode through stdin", async () => {
		const s = setup();
		await buildTemplate(s.deps, s.opts);
		const tools = s.guest.calls.find(
			(c) => c.cmd[0] === "bash" && c.cmd[1] === "-s",
		);
		expect(tools?.cmd).toEqual(["bash", "-s"]);
		expect(tools?.input?.startsWith("export SBX_VERIFY_MODE=tools\n")).toBe(
			true,
		);
		expect(tools?.input).toContain(
			readFileSync(join(templatesDir, "linux/verify.sh"), "utf8"),
		);
		const cmds = s.guest.commands();
		expect(cmds).toContain("uname -r");
		expect(cmds).toContain("systemctl --version");
		expect(cmds).toContain("sbx-agent seal");
	});

	it("writes a large build.json in chunks of at most 32 KiB", async () => {
		const s = setup();
		s.guest.packages = Array.from(
			{ length: 4000 },
			(_, i) => `ii \tpackage-number-${i}\t1.0.${i}-1ubuntu1\n`,
		).join("");
		const m = await buildTemplate(s.deps, s.opts);
		const writes = s.guest.calls.filter(
			(c) => c.cmd[0] === "sh" && String(c.cmd[2]).includes("cat >"),
		);
		expect(writes.length).toBeGreaterThan(2);
		for (const w of writes)
			expect(Buffer.byteLength(w.input ?? "")).toBeLessThanOrEqual(32 * 1024);
		const inGuest = JSON.parse(
			String(s.guest.files.get("/etc/sbx-template/build.json")),
		);
		expect(Object.keys(inGuest.packages)).toHaveLength(4000);
		expect(inGuest.buildId).toBe(m.buildId);
	});

	it("writes step logs to <logDir>/<buildId>/<step>.log", async () => {
		const logDir = join(tmp(), "build-logs");
		const s = setup({ logDir });
		const m = await buildTemplate(s.deps, s.opts);
		expect(
			readFileSync(join(logDir, m.buildId, "00-base.log"), "utf8"),
		).toContain("running /mnt/seed/build/steps/00-base.sh");
		expect(
			readFileSync(join(logDir, m.buildId, "90-cleanup.log"), "utf8"),
		).toContain("end of 90-cleanup");
	});

	it("skips verify with noVerify", async () => {
		const s = setup({ noVerify: true });
		const m = await buildTemplate(s.deps, s.opts);
		expect(m.status).toBe("ready");
		expect(m.verify).toBeUndefined();
		expect(s.verifyCalls).toHaveLength(0);
	});

	it("passes the connect option to verify unchanged", async () => {
		const s = setup({
			connect: { url: "wss://t.example.test/v1/connect", ctSsh: "u@h" },
		});
		let got: unknown;
		s.deps.verify = async (_m, o) => {
			got = o;
			return VERIFY_OK;
		};
		await buildTemplate(s.deps, s.opts);
		expect(got).toEqual({
			connect: { url: "wss://t.example.test/v1/connect", ctSsh: "u@h" },
		});
	});

	it("passes the abort signal to verify", async () => {
		const s = setup();
		const ac = new AbortController();
		s.deps.signal = ac.signal;
		let got: { signal?: AbortSignal } | undefined;
		s.deps.verify = async (_m, o) => {
			got = o;
			return VERIFY_OK;
		};
		await buildTemplate(s.deps, s.opts);
		expect(got?.signal).toBe(ac.signal);
	});
});

describe("buildTemplate: base image", () => {
	it("skips the image upload when local:import has it with the same size", async () => {
		const s = setup();
		s.pve.storage.push({
			volid: `local:import/${IMAGE_NAME}`,
			content: "import",
			size: statSync(s.image).size,
		});
		const m = await buildTemplate(s.deps, s.opts);
		expect(s.pve.uploads.map((u) => u.file.name)).toEqual([seedName(m)]);
		expect(s.node.calls.filter((c) => c.op === "media.remove")).toHaveLength(1);
	});

	it("replaces an image of a different size", async () => {
		const s = setup();
		s.pve.storage.push({
			volid: `local:import/${IMAGE_NAME}`,
			content: "import",
			size: 3,
		});
		const m = await buildTemplate(s.deps, s.opts);
		expect(s.pve.uploads.map((u) => u.file.name)).toEqual([
			IMAGE_NAME,
			seedName(m),
		]);
		expect(s.node.calls[0]).toEqual({
			op: "media.remove",
			args: { names: [IMAGE_NAME] },
		});
	});
});

describe("buildTemplate: failures", () => {
	it("a failing step deletes the VM, the ISO and the lease and records the failure", async () => {
		const s = setup({ failStep: "20-docker" });
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BuildFailedError);
		const m = (err as BuildFailedError).manifest;
		expect(s.registry.get(m.buildId)).toEqual(m);
		expect(m.status).toBe("failed");
		expect(m.error).toMatchObject({
			stage: "steps",
			step: "20-docker",
			tail: [`running ${FAIL_STEP_SCRIPT}`, "end of 20-docker"],
		});
		expect(m.error?.message).toContain("20-docker");
		expect(m.finishedAt).not.toBeNull();

		// The step ran the injected failure, not its script; later steps never ran.
		expect(s.guest.started.map((x) => x.step)).toEqual([
			"00-base",
			"10-system",
			"20-docker",
		]);
		expect(s.guest.files.get(FAIL_STEP_SCRIPT)).toBe(
			'echo "sbx-tpl: --fail-step"\nexit 1\n',
		);
		expect(s.log).not.toContain("guest:seal");

		expectInOrder(s.log, [
			`api:POST ${vm}/status/stop`,
			`api:DELETE ${vm}`,
			"node:media.remove",
			"ram:release 598",
		]);
		const del = s.pve.calls.find((c) => c.method === "DELETE" && c.path === vm);
		expect(del?.params).toEqual({ purge: 1, "destroy-unreferenced-disks": 1 });
		const removed = s.node.calls.find((c) => c.op === "media.remove");
		expect(removed?.args).toEqual({ names: [seedName(m)] });
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
		// The base image stays as a cache.
		expect(s.pve.storage.some((f) => f.volid.endsWith(IMAGE_NAME))).toBe(true);
	});

	it("keeps the VM, the ISO and the lease with keepOnFailure", async () => {
		const s = setup({ failStep: "20-docker", keepOnFailure: true });
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.status).toBe("failed");
		expect(m.error?.stage).toBe("steps");
		expect(s.pve.calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(s.pve.calls.some((c) => c.path.endsWith("/status/stop"))).toBe(
			false,
		);
		expect(s.node.calls.some((c) => c.op === "media.remove")).toBe(false);
		expect(s.pve.vms.get(598)?.status).toBe("running");
		expect((await s.allocator.get(598))?.state).toBe("reserved");
	});

	it("a failed VM create releases the lease and removes the ISO without deleting anything", async () => {
		const s = setup();
		s.pve.fail["POST /nodes/pve/qemu"] = new PveApiError(
			500,
			"unable to create VM 598",
		);
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.error).toMatchObject({ stage: "vm" });
		expect(m.error?.message).toContain("unable to create VM 598");
		expect(s.pve.calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(s.node.calls.find((c) => c.op === "media.remove")?.args).toEqual({
			names: [seedName(m)],
		});
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("leaves no build firewall (ipset, rules) on the template", async () => {
		const s = setup();
		await buildTemplate(s.deps, s.opts);
		const fw = s.pve.vms.get(598)?.firewall;
		expect(fw?.rules).toEqual([]);
		expect(fw?.ipsets).toEqual({});
		expect(fw?.options).toMatchObject({ enable: 0 });
		const del = s.pve.calls.find(
			(c) =>
				c.method === "DELETE" &&
				c.path === `${vm}/firewall/ipset/ipfilter-net0`,
		);
		expect(del?.params).toEqual({ force: 1 });
	});

	it("tags the VM right after the create call, not in it", async () => {
		const s = setup();
		await buildTemplate(s.deps, s.opts);
		const i = s.pve.calls.findIndex(
			(c) => c.method === "POST" && c.path === "/nodes/pve/qemu",
		);
		expect(s.pve.calls[i]?.params).not.toHaveProperty("tags");
		const tag = s.pve.calls.findIndex(
			(c) =>
				c.method === "PUT" &&
				c.path === `${vm}/config` &&
				c.params?.tags === "sbx-tpl",
		);
		expect(tag).toBeGreaterThan(i);
		const resize = s.pve.calls.findIndex(
			(c) => c.method === "PUT" && c.path === `${vm}/resize`,
		);
		expect(tag).toBeLessThan(resize);
	});

	it("rolls back a created VM whose tag call failed (by its description)", async () => {
		const s = setup();
		s.pve.before = (method, path, params) => {
			if (method === "PUT" && path === `${vm}/config` && params?.tags)
				throw new PveApiError(403, "Permission check failed");
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect((err as BuildFailedError).manifest.error?.stage).toBe("vm");
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("never deletes a VM whose name or tags are not the build's", async () => {
		const s = setup();
		s.pve.before = (method, path) => {
			if (method === "PUT" && path === `${vm}/resize`) {
				const v = s.pve.vms.get(598);
				if (v) v.config.name = "someone-else";
				throw new PveApiError(500, "resize failed");
			}
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect((err as BuildFailedError).manifest.error?.stage).toBe("vm");
		expect(s.pve.calls.some((c) => c.method === "DELETE")).toBe(false);
		expect(s.pve.vms.has(598)).toBe(true);
	});

	it("a red verify fails the build and deletes the template", async () => {
		const s = setup();
		s.setVerify({ ...VERIFY_OK, ok: false });
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.status).toBe("failed");
		expect(m.error?.stage).toBe("verify");
		expect(m.verify?.ok).toBe(false);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("rolls back even when recording the failure fails", async () => {
		const s = setup({ failStep: "00-base" });
		const update = s.registry.update.bind(s.registry);
		s.registry.update = (id, patch, unset) => {
			if (patch.status === "failed") throw new Error("disk full");
			return update(id, patch, unset);
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BuildFailedError);
		expect((err as BuildFailedError).manifest).toMatchObject({
			status: "failed",
			error: { stage: "steps", step: "00-base" },
		});
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
		expect(s.node.calls.some((c) => c.op === "media.remove")).toBe(true);
	});

	it("keeps the lease when the VM cannot be deleted", async () => {
		const s = setup({ failStep: "00-base" });
		s.pve.fail[`DELETE ${vm}`] = new PveApiError(500, "can't lock file");
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.error?.stage).toBe("steps");
		expect(s.pve.vms.has(598)).toBe(true);
		expect((await s.allocator.get(598))?.state).toBe("reserved");
		// The ISO goes anyway.
		expect(s.node.calls.find((c) => c.op === "media.remove")?.args).toEqual({
			names: [seedName(m)],
		});
	});

	it("a failing seal rolls back", async () => {
		const s = setup();
		s.guest.sealExit = 1;
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.error?.stage).toBe("seal");
		expect(m.error?.message).toMatch(/seal/);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("a failure while waiting for the shutdown rolls back", async () => {
		const s = setup();
		let failed = false;
		s.pve.before = (method, path) => {
			if (
				!failed &&
				method === "GET" &&
				path === `${vm}/status/current` &&
				s.log.includes(`api:POST ${vm}/agent/shutdown`)
			) {
				failed = true;
				throw new Error("GET status/current: timeout");
			}
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		expect((err as BuildFailedError).manifest.error?.stage).toBe("seal");
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("a failing template conversion rolls back", async () => {
		const s = setup();
		s.pve.fail[`POST ${vm}/template`] = new PveApiError(500, "convert failed");
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.error?.stage).toBe("template");
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
		expect(s.node.calls.find((c) => c.op === "media.remove")?.args).toEqual({
			names: [seedName(m)],
		});
	});

	it("never creates or touches a protected VMID, whatever the allocator says", async () => {
		for (const vmid of [450, 599, 9000, 9001]) {
			const s = setup();
			const released: number[] = [];
			s.deps.allocator = {
				allocateTemplate: async () => ({
					vmid,
					mac: "02:01:00:00:23:28",
					reused: false,
				}),
				markActive: async () => {},
				release: async (v) => {
					released.push(v);
				},
			};
			const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
			const m = (err as BuildFailedError).manifest;
			expect(m.error?.stage).toBe("vm");
			expect(m.error?.message).toMatch(/protected/);
			const touched = s.pve.calls.filter((c) =>
				c.path.startsWith("/nodes/pve/qemu"),
			);
			expect(touched).toEqual([]);
			expect(released).toEqual([]);
		}
	});

	it("an abort signal stops the build and rolls back", async () => {
		const s = setup();
		const ac = new AbortController();
		s.deps.signal = ac.signal;
		s.guest.onStep = (step) => {
			if (step === "10-system") ac.abort(new Error("interrupted by SIGINT"));
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.status).toBe("failed");
		expect(m.error?.message).toBe("interrupted by SIGINT");
		expect(s.guest.started.map((x) => x.step)).toEqual([
			"00-base",
			"10-system",
		]);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
		expect(s.registry.get(m.buildId)?.status).toBe("failed");
	});

	it("an abort during a task-starting call still waits for the task, then rolls back", async () => {
		const s = setup();
		const ac = new AbortController();
		s.deps.signal = ac.signal;
		s.pve.before = (method, path) => {
			if (method === "POST" && path === "/nodes/pve/qemu")
				ac.abort(new Error("interrupted by SIGTERM"));
		};
		const err = await buildTemplate(s.deps, s.opts).catch((e: unknown) => e);
		const m = (err as BuildFailedError).manifest;
		expect(m.error).toMatchObject({
			stage: "vm",
			message: "interrupted by SIGTERM",
		});
		const create = s.log.indexOf("api:POST /nodes/pve/qemu");
		expect(s.log[create + 1]).toMatch(/^api:wait UPID:/);
		// Nothing after the wait but the rollback.
		expect(s.log).not.toContain(`api:PUT ${vm}/resize`);
		expect(s.pve.vms.has(598)).toBe(false);
		expect(await s.allocator.get(598)).toBeUndefined();
	});

	it("rejects bad inputs before anything is recorded or created", async () => {
		const s = setup({ failStep: "no-such-step" });
		await expect(buildTemplate(s.deps, s.opts)).rejects.toThrow(/no-such-step/);
		const r = setup({ failStep: "reboot" });
		await expect(buildTemplate(r.deps, r.opts)).rejects.toThrow(/reboot/);
		const t = setup({ tunnelUrl: "http://x" });
		await expect(buildTemplate(t.deps, t.opts)).rejects.toThrow(/wss/);
		for (const x of [s, r, t]) {
			expect(x.registry.list()).toEqual([]);
			expect(x.pve.calls).toEqual([]);
		}
	});

	it("a second build on the same day after a failed one is .2", async () => {
		const first = setup({ failStep: "00-base" });
		await buildTemplate(first.deps, first.opts).catch(() => {});
		const second = setup({}, { registry: first.registry, work: first.work });
		const m = await buildTemplate(second.deps, second.opts);
		expect(m.version).toBe("20261030.2");
		expect(m.vmName).toBe("sbx-tpl-linux-20261030-2");
		expect(first.registry.list("linux").map((x) => x.status)).toEqual([
			"failed",
			"ready",
		]);
	});
});

describe("register output", () => {
	const m = {
		templateSlug: "linux",
		version: "20261030.1",
		os: "linux",
		node: "pve",
		storage: "local-lvm",
		pveVmid: 598,
		bootTimeoutS: 300,
		agentVersion: "1.2.3",
		diskLayout: { scsi0: { size: "64G", ssd: "1" } },
		hw: { cpu: "host", cloudinit: false, note: "it's" },
	} as unknown as Manifest;

	it("prints the sbx-admin template register line", () => {
		expect(registerCommand(m)).toBe(
			"sbx-admin template register --template linux --version 20261030.1 --os linux --node pve --storage local-lvm --pve-vmid 598 --boot-timeout-s 300 --agent-version 1.2.3 " +
				`--disk-layout '{"scsi0":{"size":"64G","ssd":"1"}}' --hw '{"cpu":"host","cloudinit":false,"note":"it'\\''s"}'`,
		);
	});

	it("prints a topology.templateBuilds entry that parses back", () => {
		const parsed = parseYaml(topologySnippet(m));
		expect(parsed).toEqual([
			{
				templateSlug: "linux",
				version: "20261030.1",
				os: "linux",
				node: "pve",
				storage: "local-lvm",
				pveVmid: 598,
				bootTimeoutS: 300,
				agentVersion: "1.2.3",
				diskLayout: { scsi0: { size: "64G", ssd: "1" } },
				hw: { cpu: "host", cloudinit: false, note: "it's" },
			},
		]);
	});
});
