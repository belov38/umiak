import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadRecipe, loadVersions, REBOOT_STEP } from "../src/recipe.ts";
import {
	APT_SNAPSHOT_SCRIPT,
	makeIso,
	renderAgentToml,
	renderSeed,
	type SeedInput,
} from "../src/seed.ts";

const repoTemplates = resolve(import.meta.dirname, "../../../infra/templates");
const fixtures = resolve(import.meta.dirname, "fixtures/templates");

const tmpDirs: string[] = [];
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "umiak-seed-test-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0))
		rmSync(d, { recursive: true, force: true });
});

const BUILD_ID = "0199c5a0-7b1e-7a3c-8d3e-5f2a9c1b4e60";
const AGENT_BYTES = Buffer.from([1, 2, 3, 0, 255]);

const UPDATE_KEYS = Buffer.from("ed25519 dGVzdA== install\n");

function input(slug = "linux-fixture", extra: Partial<SeedInput> = {}) {
	const recipe = loadRecipe(fixtures, slug, "linux");
	const agentPackage = join(tmp(), "agent.tar");
	writeFileSync(agentPackage, AGENT_BYTES);
	const i: SeedInput = {
		recipe,
		versions: loadVersions(recipe),
		buildId: BUILD_ID,
		version: "20261030.1",
		agentPackage,
		agentVersion: "1.2.3",
		updateKeys: UPDATE_KEYS,
		manifestBase: { slug, version: "20261030.1" },
		...extra,
	};
	return i;
}

function text(files: Map<string, string | Buffer>, name: string): string {
	const v = files.get(name);
	if (v === undefined) throw new Error(`missing ${name}`);
	return v.toString();
}

describe("seed templates", () => {
	it("the fixture seed matches the real linux seed", () => {
		for (const f of ["user-data.tmpl", "meta-data.tmpl", "network-config"]) {
			expect(
				readFileSync(join(fixtures, "linux-fixture/seed", f), "utf8"),
			).toBe(readFileSync(join(repoTemplates, "linux/seed", f), "utf8"));
		}
	});
});

describe("renderSeed cloud-init files", () => {
	it("meta-data", () => {
		const files = renderSeed(input());
		expect(parseYaml(text(files, "meta-data"))).toEqual({
			"instance-id": BUILD_ID,
			"local-hostname": "umiak-build",
		});
	});

	it("network-config matches by name and not by MAC", () => {
		const raw = text(renderSeed(input()), "network-config");
		expect(raw).not.toContain("macaddress");
		const cfg = parseYaml(raw);
		expect(cfg.version).toBe(2);
		const nics = Object.values(cfg.ethernets) as {
			match: object;
			dhcp4: boolean;
		}[];
		expect(nics).toHaveLength(1);
		expect(nics[0]?.match).toEqual({ name: "en*" });
		expect(nics[0]?.dhcp4).toBe(true);
	});

	it("user-data has no users, keys or passwords", () => {
		const i = input();
		const raw = text(renderSeed(i), "user-data");
		expect(raw.startsWith("#cloud-config\n")).toBe(true);
		for (const bad of ["ssh_authorized_keys", "passwd", "chpasswd"])
			expect(raw).not.toContain(bad);
		const cfg = parseYaml(raw);
		expect(cfg.users).toEqual([]);
		expect(cfg.disable_root).toBe(true);
		expect(cfg.ssh_pwauth).toBe(false);
		expect(cfg.apt.preserve_sources_list).toBe(true);
		expect(cfg.package_update).toBe(true);
		expect(cfg.packages).toEqual(["qemu-guest-agent"]);
		// One install attempt of the packages module is not enough when the archive answers
		// 503: apt retries, and runcmd installs again until the package is there.
		expect(cfg.apt.conf).toContain('Acquire::Retries "10";');
		expect(cfg.runcmd).toHaveLength(1);
		const [sh, flag, script] = cfg.runcmd[0];
		expect([sh, flag]).toEqual(["sh", "-c"]);
		expect(script).toContain("dpkg -s qemu-guest-agent");
		expect(script).toContain("apt-get update --error-on=any");
		expect(script).toContain("systemctl enable --now qemu-guest-agent");
		expect(cfg.bootcmd).toHaveLength(1);
		expect(cfg.bootcmd[0]).toEqual([
			"sh",
			"-c",
			APT_SNAPSHOT_SCRIPT,
			"sh",
			i.versions.apt.snapshot,
			"/etc/apt/sources.list.d/ubuntu.sources",
		]);
	});

	it("reads templates from the child recipe first and rejects unknown placeholders", () => {
		const i = input();
		const dir = tmp();
		mkdirSync(join(dir, "seed"));
		writeFileSync(join(dir, "seed/meta-data.tmpl"), "id: {{nope}}\n");
		const recipe = { ...i.recipe, stepDirs: [...i.recipe.stepDirs, dir] };
		expect(() => renderSeed({ ...i, recipe })).toThrow(/nope/);
		writeFileSync(join(dir, "seed/meta-data.tmpl"), "id: {{build_id}}\n");
		const files = renderSeed({ ...i, recipe });
		expect(parseYaml(text(files, "meta-data"))).toEqual({ id: BUILD_ID });
	});
});

describe("APT_SNAPSHOT_SCRIPT", () => {
	const SAMPLE = `## Ubuntu distribution packages
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: resolute resolute-updates resolute-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

## Ubuntu security updates
Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: resolute-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
	const TS = "20261029T000000Z";

	function run(file: string, ts = TS) {
		const r = spawnSync("sh", ["-c", APT_SNAPSHOT_SCRIPT, "sh", ts, file], {
			encoding: "utf8",
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		return readFileSync(file, "utf8");
	}

	it("adds Snapshot to every stanza and is idempotent", () => {
		const file = join(tmp(), "ubuntu.sources");
		writeFileSync(file, SAMPLE);
		const once = run(file);
		expect(once.match(/^Snapshot: 20261029T000000Z$/gm)).toHaveLength(2);
		// The line goes inside the stanza, directly before the blank separator.
		expect(once).toContain(
			`Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\nSnapshot: ${TS}\n\n## Ubuntu security`,
		);
		expect(once.endsWith(`keyring.gpg\nSnapshot: ${TS}\n`)).toBe(true);
		// Comments are kept and get no Snapshot line of their own.
		expect(once).toContain("## Ubuntu security updates\nTypes: deb");
		expect(run(file)).toBe(once);
	});

	it("keeps a stanza that already has a Snapshot line", () => {
		const file = join(tmp(), "ubuntu.sources");
		writeFileSync(
			file,
			"Types: deb\nURIs: http://a/\nSnapshot: 20250101T000000Z\n\nTypes: deb\nURIs: http://b/\n",
		);
		const out = run(file);
		expect(out.match(/^Snapshot:/gm)).toHaveLength(2);
		expect(out).toContain("Snapshot: 20250101T000000Z");
	});

	it("handles a file without a trailing newline and Windows-free edge cases", () => {
		const file = join(tmp(), "ubuntu.sources");
		writeFileSync(file, "Types: deb\nURIs: http://a/");
		expect(run(file)).toBe(`Types: deb\nURIs: http://a/\nSnapshot: ${TS}\n`);
	});
});

describe("renderAgentToml", () => {
	it("omits the tunnel table without a URL", () => {
		const raw = renderAgentToml();
		expect(raw).not.toContain("url =");
		expect(raw).not.toContain("[tunnel]");
		expect(parseToml(raw)).toEqual({
			user: { default: "user" },
			readiness: { required: ["identity", "claim", "secrets", "docker"] },
			docker: { enabled: true },
		});
	});

	it("sets the tunnel URL when given", () => {
		const raw = renderAgentToml("wss://tunnel.example.com/v1/connect");
		expect(raw).toContain('url = "wss://tunnel.example.com/v1/connect"');
		expect(parseToml(raw)).toMatchObject({
			tunnel: { url: "wss://tunnel.example.com/v1/connect" },
		});
	});

	it("escapes quotes in the URL", () => {
		const raw = renderAgentToml('wss://h/"x');
		expect(parseToml(raw)).toMatchObject({ tunnel: { url: 'wss://h/"x' } });
	});
});

describe("renderSeed build tree", () => {
	it("has every step except reboot, lib.sh and versions.toml", () => {
		const i = input();
		const files = renderSeed(i);
		const steps = i.recipe.steps.filter((s) => s !== REBOOT_STEP);
		expect(steps.length).toBeGreaterThan(0);
		for (const s of steps) {
			expect(files.has(`build/steps/${s}.sh`)).toBe(true);
		}
		expect([...files.keys()].some((k) => k.includes("reboot"))).toBe(false);
		expect(text(files, "build/lib.sh")).toContain("shared helpers");
		const versions = parseToml(text(files, "build/versions.toml"));
		expect(versions).toMatchObject({
			apt: { snapshot: i.versions.apt.snapshot },
			base: { serial: i.versions.base.serial },
		});
	});

	it("step files of a child recipe come from the right directory", () => {
		const i = input("child");
		const files = renderSeed(i);
		expect(files.has("build/steps/60-desktop.sh")).toBe(true);
		expect(files.has("build/steps/00-base.sh")).toBe(true);
		expect(files.has("build/steps/reboot.sh")).toBe(false);
	});

	it("copies files/ with child over parent", () => {
		const files = renderSeed(input("child"));
		expect(text(files, "build/files/etc/umiak-fixture.conf")).toBe(
			"origin=child\n",
		);
		expect(text(files, "build/files/etc/umiak-parent-only.conf")).toBe(
			"only=linux-fixture\n",
		);
		const parent = renderSeed(input());
		expect(text(parent, "build/files/etc/umiak-fixture.conf")).toBe(
			"origin=linux-fixture\n",
		);
	});

	it("build/env quotes values", () => {
		const files = renderSeed(
			input("linux-fixture", { version: "20261030.1", buildId: "a b'c" }),
		);
		const env = text(files, "build/env");
		expect(env).toContain("UMIAK_BUILD_ID='a b'\\''c'\n");
		expect(env).toContain("UMIAK_BUILD_VERSION='20261030.1'\n");
		expect(env).toContain("UMIAK_AGENT_VERSION='1.2.3'\n");
		expect(env).toContain("UMIAK_APT_SNAPSHOT='20261029T000000Z'\n");
		// The file is valid shell and round-trips the values.
		const dir = tmp();
		writeFileSync(join(dir, "env"), env);
		const out = execFileSync(
			"sh",
			[
				"-c",
				'. "$1"; printf %s "$UMIAK_BUILD_ID|$UMIAK_AGENT_VERSION"',
				"sh",
				join(dir, "env"),
			],
			{ encoding: "utf8" },
		);
		expect(out).toBe("a b'c|1.2.3");
	});

	it("includes the agent package byte for byte, agent.toml and manifest", () => {
		const i = input("linux-fixture", {
			tunnelUrl: "wss://tunnel.example.com/v1/connect",
			manifestBase: { slug: "linux-fixture", extra: [1, 2] },
		});
		const files = renderSeed(i);
		const pkg = files.get("build/umiak-agent.tar");
		expect(Buffer.isBuffer(pkg)).toBe(true);
		expect((pkg as Buffer).equals(AGENT_BYTES)).toBe(true);
		// The keys that verified the package: the first-install trust anchor.
		expect(
			(files.get("build/update-keys.pub") as Buffer).equals(UPDATE_KEYS),
		).toBe(true);
		expect(text(files, "build/agent.toml")).toBe(
			renderAgentToml("wss://tunnel.example.com/v1/connect"),
		);
		expect(JSON.parse(text(files, "build/build.json"))).toEqual({
			slug: "linux-fixture",
			extra: [1, 2],
		});
	});

	it("optional files: SSH CA, umiak CLI, config", () => {
		const bare = renderSeed(input());
		expect(text(bare, "build/ssh-user-ca.pub")).toBe("");
		expect(bare.has("build/umiak")).toBe(false);
		expect(bare.has("build/umiak-config.json")).toBe(false);

		const dir = tmp();
		const ca = join(dir, "ca.pub");
		const cli = join(dir, "umiak");
		writeFileSync(ca, "ssh-ed25519 AAAAC3Nza test-ca\n");
		writeFileSync(cli, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
		const full = renderSeed(
			input("linux-fixture", {
				sshUserCa: ca,
				umiakCli: cli,
				apiUrl: "https://api.example.com",
			}),
		);
		expect(text(full, "build/ssh-user-ca.pub")).toBe(
			"ssh-ed25519 AAAAC3Nza test-ca\n",
		);
		expect(
			(full.get("build/umiak") as Buffer).equals(
				Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
			),
		).toBe(true);
		expect(JSON.parse(text(full, "build/umiak-config.json"))).toEqual({
			apiUrl: "https://api.example.com",
		});
	});
});

describe("makeIso", () => {
	const hasXorriso = spawnSync("xorriso", ["-version"]).error === undefined;

	it.skipIf(!hasXorriso)(
		"builds an ISO labelled cidata that keeps names with dots and long names",
		() => {
			const files = renderSeed(input());
			const deep = [
				"build/steps/40-coding-agents.sh",
				"build/files/etc/sudoers.d/90-umiak-user",
				"build/files/etc/systemd/system/systemd-networkd-wait-online.service.d/10-umiak.conf",
				"build/umiak-agent-0.1.0+20261030.abc1234-linux-amd64.tar",
			];
			for (const p of deep) files.set(p, "x\n");
			const out = join(tmp(), "seed.iso");
			makeIso(files, out);
			expect(existsSync(out)).toBe(true);

			const iso = readFileSync(out);
			// Primary volume descriptor: type 1, "CD001", volume id at +40 (32 bytes).
			const pvd = 0x8000;
			expect(iso[pvd]).toBe(1);
			expect(iso.subarray(pvd + 1, pvd + 6).toString("latin1")).toBe("CD001");
			const label = iso
				.subarray(pvd + 40, pvd + 72)
				.toString("latin1")
				.replace(/[\0 ]+$/, "");
			expect(label).toBe("cidata");

			// The Rock Ridge tree as Linux mounts it (xorriso lists it back).
			const ls = spawnSync(
				"xorriso",
				["-indev", out, "-find", "/", "-type", "f", "-exec", "echo"],
				{ encoding: "utf8" },
			);
			const listed = new Set(
				ls.stdout
					.split("\n")
					.map((l) => l.trim().replace(/^'|'$/g, "").replace(/^\//, ""))
					.filter(Boolean),
			);
			for (const name of ["user-data", "meta-data", "network-config", ...deep])
				expect(listed.has(name), name).toBe(true);
		},
	);
});

describe("generic layer agent seed", () => {
	function generic() {
		return {
			binary: input().agentPackage,
			unitsDirectory: resolve(
				import.meta.dirname,
				"../../../services/guest-agent/packaging/systemd",
			),
		};
	}
	it("carries production binary and units with no CA, endpoint or legacy package", () => {
		const files = renderSeed(
			input("linux-fixture", { genericAgent: generic() }),
		);
		expect(files.has("build/umiak-agent.tar")).toBe(false);
		expect(files.get("build/generic-agent/umiak-agent")).toEqual(AGENT_BYTES);
		expect(files.has("build/generic-agent/umiak-agent.service")).toBe(true);
		expect(text(files, "build/env")).toContain("UMIAK_GENERIC_IMAGE='1'");
		expect(text(files, "build/agent.toml")).not.toContain("url =");
		expect(files.has("build/umiak-config.json")).toBe(false);
	});
	it("rejects install-bound inputs and unsafe agent versions", () => {
		for (const extra of [
			{ tunnelUrl: "wss://install.test/v1/connect" },
			{ apiUrl: "https://install.test" },
			{ sshUserCa: "/any" },
			{ agentVersion: "../bad" },
		])
			expect(() =>
				renderSeed(
					input("linux-fixture", { genericAgent: generic(), ...extra }),
				),
			).toThrow();
	});
});

it("generic seed carries stable browser/tool pins and offline bootstrap without vendor payloads", () => {
	const root = tmp();
	const binary = join(root, "agent");
	writeFileSync(binary, AGENT_BYTES);
	const unitsDirectory = join(root, "units");
	mkdirSync(unitsDirectory);
	for (const unit of [
		"umiak-agent.service",
		"umiak-identity.service",
		"umiak-agent-rollback.service",
		"umiak-cmd.slice",
	])
		writeFileSync(join(unitsDirectory, unit), "[Unit]\n");
	const files = renderSeed(
		input("linux-fixture", {
			genericAgent: { binary, unitsDirectory },
			layerCapture: true,
		}),
	);
	expect(text(files, "build/env")).toContain("UMIAK_LAYER_MODE='capture'");
	expect(files.has("build/offline-bootstrap.sh")).toBe(true);
	expect(files.has("build/build-apt-proxy.py")).toBe(true);
	expect(files.has("build/generic-chromium.sh")).toBe(true);
	expect(files.has("build/xtradeb-apps.asc")).toBe(true);
	const pins = JSON.parse(text(files, "build/layer-inputs.json"));
	expect(pins.chromium.version).toContain("xtradeb");
	expect(pins.chromium.packages.chromium).toMatch(/^[a-f0-9]{64}$/);
});
