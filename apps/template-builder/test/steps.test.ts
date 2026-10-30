import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecipe, loadVersions, REBOOT_STEP } from "../src/recipe.ts";
import { renderSeed } from "../src/seed.ts";

// Static checks of the linux recipe scripts (spec S5 sections 8, 10, 18).

const templates = resolve(import.meta.dirname, "../../../infra/templates");
const linux = join(templates, "linux");

function walk(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((rel) => join(dir, rel))
		.filter((p) => statSync(p).isFile())
		.sort();
}

function read(rel: string): string {
	return readFileSync(join(linux, rel), "utf8");
}

/** Lines without comments, so a mention in a comment does not count. */
function code(rel: string): string {
	return read(rel)
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.join("\n");
}

/** Words of the bash array `NAME=( ... )` in lib.sh. */
function bashArray(src: string, name: string): string[] {
	const m = new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(src);
	if (!m?.[1]) throw new Error(`no array ${name}`);
	return m[1]
		.split(/\s+/)
		.filter((w) => w !== "" && !w.startsWith("#"))
		.map((w) => w.replace(/^'|'$/g, ""));
}

/** Glob `*` only, as bash `case` patterns in lib.sh use it. */
function globMatch(pattern: string, name: string): boolean {
	const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${re}$`).test(name);
}

const shellcheck = spawnSync("shellcheck", ["--version"]).status === 0;

describe("recipe scripts: shellcheck", () => {
	const scripts = () => walk(templates).filter((p) => p.endsWith(".sh"));

	it("finds the scripts", () => {
		expect(scripts().map((p) => relative(linux, p))).toEqual(
			expect.arrayContaining([
				"lib.sh",
				"verify.sh",
				"steps/00-base.sh",
				"steps/10-system.sh",
				"steps/20-docker.sh",
				"steps/30-toolchains.sh",
				"steps/40-coding-agents.sh",
				"steps/50-sbx-agent.sh",
				"steps/90-cleanup.sh",
			]),
		);
	});

	it.skipIf(!shellcheck)("every .sh passes shellcheck -x -S warning", () => {
		for (const p of scripts()) {
			const r = spawnSync("shellcheck", ["-x", "-S", "warning", p], {
				encoding: "utf8",
			});
			expect(`${p}\n${r.stdout}${r.stderr}`).toBe(`${p}\n`);
		}
	});
	if (!shellcheck)
		it("shellcheck", () => {
			console.warn("shellcheck not in PATH: skipped");
		});
});

describe("recipe scripts: spec items", () => {
	const spec81Purge = [
		"snapd",
		"apport",
		"unattended-upgrades",
		"ubuntu-pro-client",
		"update-notifier-common",
		"landscape-common",
		"pollinate",
		"fwupd",
		"modemmanager",
		"multipath-tools",
		"open-iscsi",
		"udisks2",
		"lxd-installer",
		"ufw",
		"open-vm-tools",
		"rsyslog",
		"sysstat",
		"avahi-daemon",
		"cups",
		"cups-daemon",
		"tailscale",
	];

	it("00-base purges every package of the spec 8.1 list", () => {
		const purge = bashArray(code("lib.sh"), "PURGE_PACKAGES");
		for (const pkg of spec81Purge)
			expect(
				purge.some((p) => globMatch(p, pkg)),
				pkg,
			).toBe(true);
		expect(code("steps/00-base.sh")).toMatch(
			/apt_get purge [^\n]*"\$\{purge\[@\]\}"/,
		);
		expect(code("steps/00-base.sh")).toMatch(
			/installed_packages "\$\{PURGE_PACKAGES\[@\]\}"/,
		);
	});

	it("00-base installs the generic kernel and masks the spec 8.1 units", () => {
		const base = code("steps/00-base.sh");
		expect(base).toContain("linux-image-virtual");
		expect(base).toContain("full-upgrade");
		expect(bashArray(code("lib.sh"), "MASK_UNITS")).toEqual([
			"apt-daily.timer",
			"apt-daily-upgrade.timer",
			"motd-news.timer",
			"man-db.timer",
			"e2scrub_all.timer",
			"systemd-oomd.service",
			"systemd-oomd.socket",
		]);
		expect(base).toMatch(/for unit in "\$\{MASK_UNITS\[@\]\}"; do/);
	});

	it("verify.sh checks the same purge and mask lists as the steps", () => {
		const lib = code("lib.sh");
		const verify = code("verify.sh");
		expect(bashArray(verify, "PURGED")).toEqual(
			bashArray(lib, "PURGE_PACKAGES"),
		);
		expect(bashArray(verify, "MASKED")).toEqual(bashArray(lib, "MASK_UNITS"));
	});

	it("20-docker accepts only the pinned key, nothing appended", () => {
		expect(code("steps/20-docker.sh")).toMatch(
			/fprs=\$\(gpg_primary_fprs "\$key\.part"\)[^\n]*\n\[ "\$fprs" = "\$DOCKER_KEY_FPR" \] \|\| die/,
		);
	});

	it("10-system removes all three .bash_logout files", () => {
		const s = code("steps/10-system.sh");
		for (const p of [
			"/etc/skel/.bash_logout",
			"/home/user/.bash_logout",
			"/root/.bash_logout",
		])
			expect(s, p).toContain(p);
	});

	it("10-system adds the S3 PAM lines", () => {
		const s = code("steps/10-system.sh");
		expect(s).toContain(
			"session required pam_env.so readenv=1 envfile=/etc/sbx/env",
		);
		expect(s).toContain(
			"session required pam_env.so readenv=1 envfile=/run/sbx/secrets/env",
		);
	});

	it("90-cleanup disables cloud-init and removes its leftovers", () => {
		const s = code("steps/90-cleanup.sh");
		expect(s).toContain("/etc/cloud/cloud-init.disabled");
		expect(s).toContain("cloud-init clean --logs --seed");
		expect(s).toContain("/etc/netplan/50-cloud-init.yaml");
		expect(s).toContain("/etc/ssh/sshd_config.d/50-cloud-init.conf");
		expect(s).toContain("/etc/sbx-template/build.json");
	});

	it("no tailscale outside the purge list and the verify check", () => {
		const allowed = new Map([
			["lib.sh", /^PURGE_PACKAGES=\(/],
			["verify.sh", /tailscale/],
		]);
		for (const p of walk(linux)) {
			const rel = relative(linux, p);
			for (const line of readFileSync(p, "utf8").split("\n")) {
				if (!/tailscale/i.test(line)) continue;
				const ok = allowed.get(rel)?.test(line) ?? false;
				expect(ok, `${rel}: ${line}`).toBe(true);
			}
		}
	});

	it("every download is checked against versions.toml", () => {
		const s = code("steps/30-toolchains.sh");
		expect(s).not.toMatch(/curl [^\n]*\| *(ba)?sh/);
		for (const url of [
			"https://nodejs.org/dist/",
			"https://go.dev/dl/",
			"https://github.com/oven-sh/bun/releases/download/",
			"https://github.com/astral-sh/uv/releases/download/",
			"https://github.com/cli/cli/releases/download/",
			"https://static.rust-lang.org/rustup/dist/",
			"https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/",
		])
			expect(s, url).toContain(url);
		const fetches = s.match(/fetch_verify /g) ?? [];
		// node, go, bun, uv, gh, rustup-init, chrome
		expect(fetches.length).toBe(7);
		expect(code("lib.sh")).toMatch(/sha256sum -c/);
	});
});

describe("files/", () => {
	it("sshd drop-in is spec 8.3 exactly", () => {
		expect(read("files/etc/ssh/sshd_config.d/10-sbx.conf")).toBe(
			[
				"ListenAddress 127.0.0.1",
				"ListenAddress ::1",
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"PermitRootLogin prohibit-password",
				"TrustedUserCAKeys /etc/ssh/sbx_user_ca.pub",
				"",
			].join("\n"),
		);
	});

	it("grub drop-in is spec 8.5 exactly", () => {
		expect(read("files/etc/default/grub.d/90-sbx.cfg")).toBe(
			[
				"GRUB_TIMEOUT=0",
				"GRUB_TIMEOUT_STYLE=hidden",
				"GRUB_RECORDFAIL_TIMEOUT=0",
				"GRUB_DISABLE_OS_PROBER=true",
				'GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0,115200n8 systemd.machine_id=firmware quiet loglevel=3"',
				"",
			].join("\n"),
		);
	});

	it("netplan matches by name, never by MAC", () => {
		const n = read("files/etc/netplan/10-sbx.yaml");
		expect(n).toContain('name: "en*"');
		expect(n).toContain("dhcp4: true");
		expect(n).toContain("dhcp6: false");
		expect(n).toContain("accept-ra: false");
		expect(n).not.toContain("macaddress");
	});

	it("the other drop-ins carry the spec values", () => {
		expect(
			read(
				"files/etc/systemd/system/systemd-networkd-wait-online.service.d/10-sbx.conf",
			),
		).toMatch(
			/^ExecStart=\nExecStart=\S+systemd-networkd-wait-online --any --timeout=15$/m,
		);
		expect(read("files/etc/systemd/resolved.conf.d/10-sbx.conf")).toContain(
			"FallbackDNS=1.1.1.1 9.9.9.9",
		);
		const sysctl = read("files/etc/sysctl.d/90-sbx.conf");
		for (const kv of [
			"kernel.apparmor_restrict_unprivileged_userns = 0",
			"fs.inotify.max_user_watches = 524288",
			"fs.inotify.max_user_instances = 1024",
		])
			expect(sysctl).toContain(kv);
		expect(read("files/etc/systemd/system.conf.d/90-sbx.conf")).toContain(
			"DefaultLimitNOFILE=65536:524288",
		);
		const journald = read("files/etc/systemd/journald.conf.d/90-sbx.conf");
		for (const kv of [
			"Storage=persistent",
			"SystemMaxUse=256M",
			"RuntimeMaxUse=64M",
		])
			expect(journald).toContain(kv);
		expect(JSON.parse(read("files/etc/docker/daemon.json"))).toEqual({
			"log-driver": "local",
		});
		expect(read("files/etc/sudoers.d/90-sbx-user")).toBe(
			"user ALL=(ALL) NOPASSWD:ALL\n",
		);
	});

	it("coding-agent CLIs have auto-update off", () => {
		expect(
			JSON.parse(read("files/etc/claude-code/managed-settings.json")),
		).toEqual({ env: { DISABLE_AUTOUPDATER: "1" } });
		expect(JSON.parse(read("files/etc/opencode/opencode.json"))).toEqual({
			autoupdate: false,
		});
		expect(JSON.parse(read("files/etc/gemini-cli/settings.json"))).toEqual({
			general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
		});
		expect(read("files/etc/codex/config.toml")).toMatch(
			/^check_for_update_on_startup = false$/m,
		);
	});
});

describe("verify.sh", () => {
	it("reports every check id the plan names", () => {
		const v = code("verify.sh");
		for (const id of [
			"os",
			"kernel",
			"systemd",
			"cmdline",
			"machine_id",
			"swap",
			"listen_tcp",
			"listen_udp",
			"sshd_config",
			"ssh_host_keys",
			"pam",
			"cloudinit",
			"netplan",
			"ipv4",
			"user",
			"sudo",
			"linger",
			"no_other_users",
			"passwords_locked",
			"no_authorized_keys",
			"dns",
			"https",
			"wait_online",
			"system_running",
			"failed_units",
			"jobs",
			"masked_units",
			"purged_absent",
			"leftovers",
			"sysctl",
			"userns",
			"disk_size",
			"fstrim",
			"kvm",
			"bash_logout",
			"no_tailscale",
			"no_unattended",
			"no_ci_drive",
			"hostname",
		])
			expect(v, id).toMatch(new RegExp(`report ${id} `));
	});

	it("checks every tool of spec 8.9", () => {
		const v = code("verify.sh");
		for (const t of [
			"node",
			"npm",
			"npx",
			"bun",
			"bunx",
			"go",
			"gofmt",
			"cargo",
			"rustc",
			"rustup",
			"rustfmt",
			"cargo-clippy",
			"clippy-driver",
			"python3",
			"pip3",
			"uv",
			"uvx",
			"gh",
			"java",
			"javac",
			"jar",
			"docker",
			"docker-compose",
			"docker-buildx",
			"google-chrome",
			"google-chrome-stable",
			"ffmpeg",
			"xdotool",
			"claude",
			"codex",
			"opencode",
			"gemini",
			"pnpm",
			"sbx",
			"git",
			"git-lfs",
			"rg",
			"fd",
			"jq",
		])
			expect(v, t).toMatch(new RegExp(`^\\s+"${t}\\|`, "m"));
	});

	it("never reads the rest of the script from stdin", () => {
		// bash -s: a command that reads stdin would eat the script.
		expect(read("verify.sh").trimEnd().split("\n").at(-1)).toBe(
			"main </dev/null",
		);
	});
});

describe("renderSeed on the real linux recipe", () => {
	it("renders every step, lib.sh and files/", () => {
		const recipe = loadRecipe(templates, "linux");
		const dir = mkdtempSync(join(tmpdir(), "sbx-steps-test-"));
		const agentPackage = join(dir, "agent.tar");
		writeFileSync(agentPackage, "x");
		let files: Map<string, string | Buffer>;
		try {
			files = renderSeed({
				recipe,
				versions: loadVersions(recipe),
				buildId: "0199c5a0-7b1e-7a3c-8d3e-5f2a9c1b4e60",
				version: "20261030.1",
				agentPackage,
				agentVersion: "1.2.3",
				manifestBase: {},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		for (const step of recipe.steps.filter((s) => s !== REBOOT_STEP))
			expect(files.get(`build/steps/${step}.sh`)?.toString()).toBe(
				read(`steps/${step}.sh`),
			);
		expect(files.get("build/lib.sh")?.toString()).toBe(read("lib.sh"));
		expect(files.has("build/files/etc/ssh/sshd_config.d/10-sbx.conf")).toBe(
			true,
		);
		expect(files.has("build/files/etc/sudoers.d/90-sbx-user")).toBe(true);
	});
});

const gpg = spawnSync("gpg", ["--version"]).status === 0;

describe("lib.sh gpg_primary_fprs", () => {
	// A throwaway build dir: lib.sh needs build/env next to it.
	function run(keyFile: string, dir: string): string[] {
		copyFileSync(join(linux, "lib.sh"), join(dir, "lib.sh"));
		writeFileSync(join(dir, "env"), "SBX_BUILD_ID='x'\n");
		// lib.sh sets the Ubuntu PATH; keep the host's to find gpg.
		const r = spawnSync(
			"bash",
			[
				"-c",
				'p=$PATH; . "$1/lib.sh"; PATH=$p; gpg_primary_fprs "$2"',
				"_",
				dir,
				keyFile,
			],
			{ encoding: "utf8" },
		);
		expect(r.status, r.stderr).toBe(0);
		return r.stdout.split("\n").filter((l) => l !== "");
	}

	it.skipIf(!gpg)(
		"lists every primary key and no subkey",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "sbx-gpg-"));
			try {
				const home = join(dir, "gnupg");
				mkdirSync(home, { mode: 0o700 });
				const g = (...args: string[]) =>
					spawnSync(
						"gpg",
						[
							"--homedir",
							home,
							"--batch",
							"--pinentry-mode",
							"loopback",
							"--passphrase",
							"",
							...args,
						],
						{ encoding: "utf8" },
					);
				const fprs: string[] = [];
				for (const uid of ["a@sbx.test", "b@sbx.test"]) {
					// default algo: primary key + encryption subkey
					expect(
						g("--quick-gen-key", uid, "default", "default", "never").status,
					).toBe(0);
					const list = g("--with-colons", "--list-keys", uid).stdout;
					const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(list)?.[1];
					expect(fpr).toBeDefined();
					fprs.push(fpr as string);
				}
				const one = join(dir, "one.asc");
				const both = join(dir, "both.asc");
				writeFileSync(one, g("--armor", "--export", "a@sbx.test").stdout);
				writeFileSync(
					both,
					g("--armor", "--export", "a@sbx.test", "b@sbx.test").stdout,
				);
				expect(run(one, dir)).toEqual([fprs[0]]);
				expect(run(both, dir).sort()).toEqual([...fprs].sort());
			} finally {
				spawnSync("gpgconf", [
					"--homedir",
					join(dir, "gnupg"),
					"--kill",
					"all",
				]);
				rmSync(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
