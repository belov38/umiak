import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XMLValidator } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadRecipe,
	loadVersions,
	recipeFile,
	type WindowsRecipe,
} from "../src/recipe.ts";
import { makeIso } from "../src/seed.ts";
import {
	BUILD_ISO_LABEL,
	type BuildIsoInput,
	buildIsoFiles,
	OFFLINE_ISO_LABEL,
	OFFLINE_SERVICES,
	offlineIsoFiles,
	offlineServices,
	SYSPREP_DEFERRED_SERVICES,
} from "../src/windows/media.ts";
import {
	UMIAK_UNATTEND,
	unattendPassword,
	WINDOWS_FILES_DIR,
} from "../src/windows/unattend.ts";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
	...(await orig<typeof import("node:child_process")>()),
	execFileSync,
}));

const repoTemplates = resolve(import.meta.dirname, "../../../infra/templates");
const fixtures = resolve(import.meta.dirname, "fixtures/templates");

const AGENT = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0, 1, 255]);
const PASSWORD = "S3cret-build-pw";
const BUILD_ID = "0199c5a0-7b1e-7a3c-8d3e-5f2a9c1b4e60";

/** The fixture recipe on top of the real `_windows` files (unattend, scripts). */
function recipe(): WindowsRecipe {
	const r = loadRecipe(fixtures, "windows-fixture", "windows");
	return { ...r, stepDirs: [WINDOWS_FILES_DIR, ...r.stepDirs] };
}

function input(extra: Partial<BuildIsoInput> = {}): BuildIsoInput {
	const r = recipe();
	return {
		recipe: r,
		versions: loadVersions(r),
		agentTar: AGENT,
		agentVersion: "0.4.0+20261031.abc1234",
		agentToml: '[user]\ndefault = "user"\n',
		buildPassword: PASSWORD,
		buildId: BUILD_ID,
		...extra,
	};
}

const KEY = "VK7JG-NPHTM-C97JM-9MPGT-3V66T";
const ANSWERS = { uiLanguage: "en-GB", productKey: KEY };

function text(files: Map<string, string | Buffer>, name: string): string {
	const v = files.get(name);
	if (v === undefined) throw new Error(`missing ${name}`);
	return v.toString();
}

/** Lines of `:label` up to the next label (CRLF normalized). */
function section(cmd: string, label: string): string[] {
	const lines = cmd.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === `:${label}`);
	expect(start, label).toBeGreaterThanOrEqual(0);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => l.startsWith(":"));
	return end < 0 ? rest : rest.slice(0, end);
}

describe("repo files", () => {
	it("the real windows recipe finds every builder file in _windows", () => {
		const r = loadRecipe(repoTemplates, "windows", "windows");
		for (const f of [
			"autounattend.xml.tmpl",
			"umiak-unattend.xml",
			"offline-autounattend.xml",
			"offline.cmd",
			"SetupComplete.cmd",
			"run-step.ps1",
		])
			expect(recipeFile(r, f)).toBe(join(WINDOWS_FILES_DIR, f));
	});
});

describe("offline.cmd", () => {
	const cmd = offlineIsoFiles(["defender-off", "waasmedic-off"], ANSWERS).get(
		"offline.cmd",
	) as string;

	it("offline.cmd sets Start=4 for WinDefend, WdNisSvc, Sense, WdBoot, WdFilter, WdNisDrv, WaaSMedicSvc", () => {
		expect(OFFLINE_SERVICES).toEqual({
			"defender-off": [
				"WinDefend",
				"WdNisSvc",
				"Sense",
				"WdBoot",
				"WdFilter",
				"WdNisDrv",
			],
			"waasmedic-off": ["WaaSMedicSvc"],
		});
		const disable = section(cmd, "disable").join("\n");
		expect(disable).toMatch(
			/reg add "%CS%\\Services\\%~1" \/v Start \/t REG_DWORD \/d 4 \/f/,
		);
		// Every ControlSet00x present, of the loaded offline SYSTEM hive.
		expect(cmd).toContain(
			'reg load HKLM\\OFFSYS "%WIN%\\Windows\\System32\\config\\SYSTEM"',
		);
		expect(cmd).toContain("reg unload HKLM\\OFFSYS");
		expect(cmd).toMatch(/for %%n in \(001 002 003 004 005 006 007 008 009\)/);
		expect(cmd).toContain("HKLM\\OFFSYS\\ControlSet%%n");
	});

	it("loads vioscsi, logs to the Windows volume and powers off", () => {
		expect(cmd).toContain(
			'drvload "%VIRTIO%\\vioscsi\\%UMIAK_DRIVERS%\\amd64\\vioscsi.inf"',
		);
		expect(cmd).toContain("\\Windows\\Setup\\Scripts\\umiak-offline.log");
		expect(cmd).toContain("wpeutil shutdown");
		// The WinPE system volume X: is never taken for the installed Windows.
		const find = section(cmd, "find_windows").join("\n");
		expect(find).toContain("System32\\config\\SYSTEM");
		expect(find).not.toMatch(/\bX\b/);
		// CRLF only: cmd mis-parses labels in LF-only files.
		expect(cmd.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
	});

	it("always powers off; failures are counted and logged as DONE errors <n>", () => {
		expect(cmd).not.toMatch(/^:hang/m);
		const code = cmd.split("\r\n").filter((l) => !/^\s*rem\b/i.test(l));
		expect(code.filter((l) => l.includes("wpeutil shutdown"))).toEqual([
			"wpeutil shutdown",
		]);
		expect(section(cmd, "shutdown").join("\n")).toContain("wpeutil shutdown");
		for (const label of ["no_virtio", "no_windows", "no_hive"]) {
			const body = section(cmd, label).join("\n");
			expect(body, label).toContain("set /a ERRORS+=1");
			expect(body, label).toContain("call :log ERROR");
			expect(body.trim().endsWith("goto finish"), label).toBe(true);
		}
		const finish = section(cmd, "finish").join("\n");
		expect(finish).toContain("call :log DONE errors %ERRORS%");
		expect(finish).toContain(
			'copy /y "%LOG%" "%WIN%\\Windows\\Setup\\Scripts\\umiak-offline.log"',
		);
		// No path skips the log line or the shutdown: finish falls through to shutdown.
		expect(finish).not.toMatch(/exit \/b/);
		expect(cmd.indexOf(":finish")).toBeLessThan(cmd.indexOf(":shutdown"));
	});

	it("the diskpart fallback brings disk 0 online and writable", () => {
		const dp = section(cmd, "assign_letter")
			.filter((l) => l.includes("umiak-diskpart.txt echo"))
			.map((l) => l.replace(/^.*umiak-diskpart\.txt echo /, ""));
		expect(dp).toEqual([
			"select disk 0",
			"rescan",
			"online disk noerr",
			"attributes disk clear readonly noerr",
			"select partition 3",
			"assign letter=W noerr",
		]);
	});
});

describe("offlineIsoFiles", () => {
	it("has the answer file, offline.cmd and the stage config", () => {
		const files = offlineIsoFiles(["defender-off", "waasmedic-off"], ANSWERS);
		expect([...files.keys()].sort()).toEqual([
			"autounattend.xml",
			"offline-config.cmd",
			"offline.cmd",
		]);
		const xml = text(files, "autounattend.xml");
		expect(XMLValidator.validate(xml)).toBe(true);
		// The language page would stop Setup before RunSynchronous starts offline.cmd.
		expect(xml).toContain("<UILanguage>en-GB</UILanguage>");
		expect(xml).toContain(`<Key>${KEY}</Key>`);
		expect(xml).toContain("<AcceptEula>true</AcceptEula>");
		const cfg = text(files, "offline-config.cmd");
		expect(cfg).toBe(
			"set UMIAK_DRIVERS=w11\r\nset UMIAK_SERVICES=WinDefend WdNisSvc Sense WdBoot WdFilter WdNisDrv WaaSMedicSvc\r\n",
		);
	});

	it("leaves the services sysprep needs alive out: the offline boot comes before sysprep", () => {
		expect(SYSPREP_DEFERRED_SERVICES).toEqual(["dmwappushservice"]);
		const cfg = text(
			offlineIsoFiles(["defender-off"], ANSWERS),
			"offline-config.cmd",
		);
		expect(cfg).not.toContain("dmwappushservice");
		expect(offlineServices(["defender-off", "waasmedic-off"])).toEqual([
			"WinDefend",
			"WdNisSvc",
			"Sense",
			"WdBoot",
			"WdFilter",
			"WdNisDrv",
			"WaaSMedicSvc",
		]);
	});

	it("selects services of the given stages only", () => {
		const cfg = text(
			offlineIsoFiles(["waasmedic-off"], { ...ANSWERS, drivers: "2k25" }),
			"offline-config.cmd",
		);
		expect(cfg).toBe(
			"set UMIAK_DRIVERS=2k25\r\nset UMIAK_SERVICES=WaaSMedicSvc\r\n",
		);
	});

	it("rejects unknown stages and an empty list", () => {
		expect(() => offlineIsoFiles(["nope" as "defender-off"], ANSWERS)).toThrow(
			/nope/,
		);
		expect(() => offlineIsoFiles([], ANSWERS)).toThrow(/stage/);
	});

	it("volume labels", () => {
		expect(BUILD_ISO_LABEL).toBe("UMIAKBUILD");
		expect(OFFLINE_ISO_LABEL).toBe("UMIAKOFFL");
	});
});

describe("buildIsoFiles", () => {
	it("build ISO file map has the spec §6.3 layout", () => {
		const i = input();
		const files = buildIsoFiles(i);
		expect([...files.keys()].sort()).toEqual(
			[
				"autounattend.xml",
				"build/SetupComplete.cmd",
				"build/run-step.ps1",
				"build/steps/00-base.ps1",
				"build/steps/10-system.ps1",
				"build/steps/90-cleanup.ps1",
				"build/versions.toml",
				"build/versions.json",
				"build/agent.toml",
				"build/umiak-agent-0.4.0+20261031.abc1234-windows-amd64.tar",
				"build/ssh-user-ca.pub",
				"build/umiak-unattend.xml",
				// lib.ps1 and files/ of the shared _windows directory.
				"build/lib.ps1",
				"build/files/appx-remove.txt",
				"build/files/gpt.ini",
				"build/files/profile.ps1",
				"build/files/umiak-early.cmd",
				"build/files/scripts.ini",
				"build/files/sshd_config",
				"build/files/firstboot.ps1",
				"build/files/SetupComplete-clone.cmd",
			].sort(),
		);
		expect(
			(
				files.get(
					"build/umiak-agent-0.4.0+20261031.abc1234-windows-amd64.tar",
				) as Buffer
			).equals(AGENT),
		).toBe(true);
		expect(text(files, "build/agent.toml")).toBe(i.agentToml);
		expect(text(files, "build/ssh-user-ca.pub")).toBe("");
		expect(text(files, "build/umiak-unattend.xml")).toBe(UMIAK_UNATTEND);
		// Child recipe over the shared directory.
		expect(text(files, "build/steps/10-system.ps1")).toContain(
			"recipe 10-system",
		);
		expect(text(files, "build/steps/00-base.ps1")).toContain("shared 00-base");
	});

	it("the build password is only in autounattend.xml", () => {
		const files = buildIsoFiles(input());
		const encoded = unattendPassword(PASSWORD);
		for (const [name, data] of files) {
			const s = data.toString();
			expect(s, name).not.toContain(PASSWORD);
			if (name !== "autounattend.xml") expect(s, name).not.toContain(encoded);
		}
		expect(text(files, "autounattend.xml")).toContain(encoded);
	});

	it("autounattend: edition and generic key from versions, w11 drivers", () => {
		const xml = text(buildIsoFiles(input()), "autounattend.xml");
		expect(xml).toContain("<Value>Windows 11 Pro</Value>");
		expect(xml).toContain("<Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key>");
		expect(xml).toContain("<UILanguage>en-GB</UILanguage>");
		expect(xml).toContain("D:\\vioscsi\\w11\\amd64");
	});

	it("product key override: a real key, or none", () => {
		const real = text(
			buildIsoFiles(input({ productKey: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE" })),
			"autounattend.xml",
		);
		expect(real).toContain("<Key>AAAAA-BBBBB-CCCCC-DDDDD-EEEEE</Key>");
		expect(real).not.toContain("VK7JG");
		const none = text(
			buildIsoFiles(input({ productKey: null })),
			"autounattend.xml",
		);
		expect(none).not.toContain("<ProductKey>");
		// Evaluation media: no key name in versions either.
		const i = input();
		const v = { ...i.versions, iso: { ...i.versions.iso, productKey: null } };
		expect(
			text(buildIsoFiles({ ...i, versions: v }), "autounattend.xml"),
		).not.toContain("<ProductKey>");
	});

	it("versions.json carries tool URLs and sha256, npm pins and options, no ISO data", () => {
		const i = input();
		const files = buildIsoFiles(i);
		const v = JSON.parse(text(files, "build/versions.json"));
		expect(v.buildId).toBe(BUILD_ID);
		expect(v.agent).toEqual({
			version: "0.4.0+20261031.abc1234",
			package: "umiak-agent-0.4.0+20261031.abc1234-windows-amd64.tar",
		});
		expect(v.tools.pwsh).toEqual(i.versions.tools.pwsh);
		expect(v.tools.gh.url).toMatch(/^https:\/\//);
		expect(v.tools.gh.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(v.npm).toEqual(i.versions.npm);
		expect(v.openssh).toEqual({ source: "inbox" });
		expect(v.virtioWin).toEqual(i.versions.virtioWin);
		expect(v.options).toEqual({ vsBuildtools: false });
		expect(v.iso).toBeUndefined();
		expect(text(files, "build/versions.json")).not.toContain("VK7JG");

		const toml = parseToml(text(files, "build/versions.toml")) as {
			tools: { pwsh: { version: string } };
		};
		expect(toml.tools.pwsh.version).toBe(i.versions.tools.pwsh.version);
	});

	it("optional SSH CA, lib.ps1 and files/ from the recipe", () => {
		const r = recipe();
		const files = buildIsoFiles(
			input({
				sshUserCa: "ssh-ed25519 AAAAC3Nza ca\n",
				recipe: {
					...r,
					stepDirs: [...r.stepDirs, join(fixtures, "linux-fixture")],
				},
			}),
		);
		expect(text(files, "build/ssh-user-ca.pub")).toBe(
			"ssh-ed25519 AAAAC3Nza ca\n",
		);
		// linux-fixture brings files/etc/...; no lib.ps1 there, so the shared one stays.
		expect(
			[...files.keys()].some((k) => k.startsWith("build/files/etc/")),
		).toBe(true);
		expect(text(files, "build/lib.ps1")).toBe(
			readFileSync(join(WINDOWS_FILES_DIR, "lib.ps1"), "utf8"),
		);
	});

	it("rejects step and files/ names Joliet would truncate", () => {
		const r = recipe();
		const long = "a".repeat(62);
		const dir = mkdtempSync(join(tmpdir(), "umiak-media-test-"));
		try {
			mkdirSync(join(dir, "steps"));
			writeFileSync(join(dir, "steps", `${long}.ps1`), "Write-Output 1\n");
			const withStep = {
				...r,
				steps: [...r.steps, long],
				stepDirs: [...r.stepDirs, dir],
			};
			expect(() => buildIsoFiles(input({ recipe: withStep }))).toThrow(
				new RegExp(`${long}\\.ps1.*64 characters`),
			);

			rmSync(join(dir, "steps"), { recursive: true });
			mkdirSync(join(dir, "files", "x"), { recursive: true });
			writeFileSync(join(dir, "files", "x", `${long}.txt`), "x\n");
			const withFile = { ...r, stepDirs: [...r.stepDirs, dir] };
			expect(() => buildIsoFiles(input({ recipe: withFile }))).toThrow(
				/build\/files\/x\/a+\.txt.*64 characters/,
			);
			// 64 characters is still fine.
			rmSync(join(dir, "files"), { recursive: true });
			mkdirSync(join(dir, "files"));
			writeFileSync(join(dir, "files", `${"b".repeat(60)}.txt`), "x\n");
			expect(() => buildIsoFiles(input({ recipe: withFile }))).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an agent version that is not a safe file name", () => {
		expect(() => buildIsoFiles(input({ agentVersion: "../x" }))).toThrow(
			/agent version/,
		);
		// Joliet, which Windows reads, keeps at most 64 characters of a name.
		expect(() =>
			buildIsoFiles(input({ agentVersion: `1.0.0+${"a".repeat(40)}` })),
		).toThrow(/64/);
	});

	it("cmd files use CRLF; every text file is ASCII", () => {
		const files = buildIsoFiles(input());
		const cmd = text(files, "build/SetupComplete.cmd");
		expect(cmd.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
		// Windows PowerShell 5.1 and cmd read BOM-less files in the ANSI code page.
		const off = offlineIsoFiles(["defender-off"], ANSWERS);
		for (const [name, data] of [
			...[
				"autounattend.xml",
				"build/SetupComplete.cmd",
				"build/run-step.ps1",
				"build/umiak-unattend.xml",
			].map((n) => [n, files.get(n)] as const),
			...off,
		]) {
			const buf = Buffer.from(data ?? "");
			expect(buf.length, name).toBeGreaterThan(0);
			expect(
				buf.every((b) => b < 0x80),
				name,
			).toBe(true);
		}
	});
});

describe("SetupComplete.cmd", () => {
	const cmd = text(buildIsoFiles(input()), "build/SetupComplete.cmd");

	it("installs virtio guest tools and QGA from the virtio-win drive", () => {
		expect(cmd).toContain("virtio-win-gt-x64.msi");
		expect(cmd).toContain("guest-agent\\qemu-ga-x86_64.msi");
		expect(cmd).toMatch(
			/msiexec(\.exe)? \/i "%VIRTIO%\\virtio-win-gt-x64.msi"/,
		);
		expect(cmd).toContain("/qn");
		expect(cmd).toContain("/norestart");
		expect(cmd).toContain("C:\\umiak-build\\logs");
	});
});

describe("run-step.ps1", () => {
	const ps = text(buildIsoFiles(input()), "build/run-step.ps1");

	it("follows the step contract", () => {
		expect(ps).toMatch(
			/param\s*\(\s*\[Parameter\(Mandatory\s*=\s*\$true\)\][^)]*\)\]\s*\[string\]\s*\$Step\s*\)/i,
		);
		expect(ps).toContain("Get-Volume -FileSystemLabel UMIAKBUILD");
		expect(ps).toContain("C:\\umiak-build\\logs");
		expect(ps).toContain("#requires -Version 7");
		expect(ps).toContain("PowerShell\\7\\pwsh.exe");
		// UTF-8 without BOM: never Out-File/Set-Content -Encoding utf8 for the log.
		expect(ps).toContain("UTF8Encoding($false)");
		expect(ps).not.toMatch(/Out-File/i);
		// The exit file is written last, through a rename.
		expect(ps).toContain(".exit.tmp");
		expect(ps).toMatch(/Set-Content[^\n]*-NoNewline/);
		expect(ps).toMatch(/Move-Item[^\n]*-Force/);
		const lastMove = ps.lastIndexOf("Move-Item");
		const lastLog = ps.lastIndexOf("Write-Log");
		expect(lastMove).toBeGreaterThan(lastLog);
	});
});

describe("makeIso volume label", () => {
	beforeEach(() => execFileSync.mockReset());

	it("makeIso passes -V UMIAKBUILD", () => {
		makeIso(
			new Map([["a", "b"]]),
			"/tmp/umiak-test-build.iso",
			BUILD_ISO_LABEL,
		);
		expect(execFileSync).toHaveBeenCalledTimes(1);
		const [tool, args] = execFileSync.mock.calls[0] as [string, string[]];
		expect(tool).toBe("xorriso");
		expect(args.slice(0, 5)).toEqual([
			"-as",
			"mkisofs",
			"-V",
			"UMIAKBUILD",
			"-J",
		]);
	});

	it("defaults to cidata (linux seed unchanged)", () => {
		makeIso(new Map([["a", "b"]]), "/tmp/umiak-test-seed.iso");
		const [, args] = execFileSync.mock.calls[0] as [string, string[]];
		expect(args[3]).toBe("cidata");
	});

	it("rejects a label ISO 9660 cannot hold", () => {
		expect(() =>
			makeIso(new Map(), "/tmp/umiak-test-bad.iso", "bad label!"),
		).toThrow(/label/);
		expect(execFileSync).not.toHaveBeenCalled();
	});
});
