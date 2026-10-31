import { spawnSync } from "node:child_process";
import {
	chmodSync,
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
import {
	isBuiltinStep,
	loadRecipe,
	loadVersions,
	stepFile,
	WINDOWS_TOOLS,
	type WindowsRecipe,
} from "../src/recipe.ts";
import {
	buildIsoFiles,
	SYSPREP_DEFERRED_SERVICES,
} from "../src/windows/media.ts";

// Static checks of the Windows image steps and files (spec S9 section 8).

const templates = resolve(import.meta.dirname, "../../../infra/templates");
const shared = join(templates, "_windows");

const PWSH7_STEPS = [
	"30-toolchains",
	"40-coding-agents",
	"50-sbx-agent",
	"60-desktop",
	"90-cleanup",
];
const PS51_STEPS = ["00-base", "10-system"];
/** The same rule run-step.ps1 applies to the first line. */
const PWSH7_HEADER = /^\s*#requires\s+-Version\s+7(\.\d+)*\s*$/;

/** Services of spec S9 section 8.1 that end up Disabled. */
const DISABLED_SERVICES = [
	"wuauserv",
	"UsoSvc",
	"DoSvc",
	"WSearch",
	"SysMain",
	"DiagTrack",
	"dmwappushservice",
	"MapsBroker",
	"lfsvc",
	"WerSvc",
	"RemoteRegistry",
	"Spooler",
	"SSDPSRV",
	"FDResPub",
	"LanmanServer",
	"TermService",
	"WinRM",
	"CDPSvc",
];

/** Appx packages the image keeps (spec S9 section 8.1) and frameworks they need. */
const KEPT_APPX = [
	"Microsoft.MicrosoftEdge.Stable",
	"Microsoft.WindowsTerminal",
	"Microsoft.WindowsNotepad",
	"Microsoft.WindowsCalculator",
	"Microsoft.Paint",
	"Microsoft.ScreenSketch",
	"Microsoft.Windows.Photos",
	"Microsoft.WindowsStore",
	"Microsoft.StorePurchaseApp",
	"Microsoft.DesktopAppInstaller",
	"Microsoft.VCLibs.140.00",
	"Microsoft.VCLibs.140.00.UWPDesktop",
	"Microsoft.UI.Xaml.2.8",
	"Microsoft.NET.Native.Framework.2.2",
	"Microsoft.NET.Native.Runtime.2.2",
	"Microsoft.WindowsAppRuntime.1.6",
	"Microsoft.SecHealthUI",
];

function read(rel: string): string {
	return readFileSync(join(shared, rel), "utf8");
}

/** Lines without comments, so a mention in a comment does not count. */
function code(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((l) => !/^\s*#/.test(l))
		.join("\n");
}

function ps1Files(): string[] {
	return readdirSync(shared, { recursive: true, encoding: "utf8" })
		.filter((rel) => rel.endsWith(".ps1"))
		.filter((rel) => statSync(join(shared, rel)).isFile())
		.sort();
}

function recipe(): WindowsRecipe {
	return loadRecipe(templates, "windows", "windows");
}

function scriptSteps(): string[] {
	const r = recipe();
	return r.steps.filter((s) => !isBuiltinStep(r, s));
}

/** Same `*` semantics as removedAppx in src/windows/stages.ts (case-insensitive). */
function appxMatch(pattern: string, name: string): boolean {
	const re = pattern
		.split("*")
		.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${re}$`, "i").test(name);
}

/** Single-quoted words of the PowerShell array `$Name = @( ... )` in lib.ps1. */
function psArray(src: string, name: string): string[] {
	const m = new RegExp(`^\\$${name}\\s*=\\s*@\\(([^)]*)\\)`, "m").exec(src);
	if (!m?.[1]) throw new Error(`no array $${name}`);
	return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
}

describe("windows steps: files", () => {
	it("every script step of the recipe has a file in _windows/steps", () => {
		const r = recipe();
		const steps = scriptSteps();
		expect(steps).toEqual([...PS51_STEPS, ...PWSH7_STEPS]);
		for (const s of steps)
			expect(relative(shared, stepFile(r, s))).toBe(join("steps", `${s}.ps1`));
	});

	it("pwsh steps start with #requires -Version 7, the 5.1 steps do not", () => {
		for (const s of PWSH7_STEPS) {
			const first = read(`steps/${s}.ps1`).split(/\r?\n/, 1)[0];
			expect(first, s).toMatch(PWSH7_HEADER);
		}
		for (const s of PS51_STEPS) {
			const first = read(`steps/${s}.ps1`).split(/\r?\n/, 1)[0];
			expect(first, s).not.toMatch(PWSH7_HEADER);
		}
	});

	it("every step dot-sources lib.ps1; lib.ps1 stops on errors", () => {
		for (const s of scriptSteps())
			expect(read(`steps/${s}.ps1`), s).toMatch(
				/^\. \(Join-Path \$PSScriptRoot '\.\.\\lib\.ps1'\)$/m,
			);
		const lib = code(read("lib.ps1"));
		expect(lib).toMatch(/^\$ErrorActionPreference = 'Stop'$/m);
		expect(lib).toMatch(/function Assert-Sha256\b[\s\S]*Get-FileHash/);
	});

	it("the .ps1 files are ASCII (Windows PowerShell 5.1 reads them as ANSI)", () => {
		for (const rel of [
			...ps1Files(),
			"files/scripts.ini",
			"files/gpt.ini",
			"files/sbx-early.cmd",
			"files/SetupComplete-clone.cmd",
		])
			expect(
				[...read(rel)].every(
					(c) =>
						c === "\t" || c === "\n" || c === "\r" || (c >= " " && c <= "~"),
				),
				rel,
			).toBe(true);
	});

	it("no Invoke-Expression in the scripts", () => {
		for (const rel of ps1Files())
			expect(code(read(rel)), rel).not.toMatch(
				/\bInvoke-Expression\b|\biex\b/i,
			);
	});

	it("every download is followed by Assert-Sha256; steps download only through lib.ps1", () => {
		const download =
			/Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|DownloadFile|\bcurl(\.exe)?\b|\bwget\b/gi;
		let found = 0;
		for (const rel of ps1Files()) {
			const src = code(read(rel));
			const hits = [...src.matchAll(download)];
			if (rel.startsWith("steps")) expect(hits, rel).toEqual([]);
			hits.forEach((m, i) => {
				found++;
				const next = hits[i + 1]?.index ?? src.length;
				const after = src.slice(m.index, next).split("\n").slice(0, 25);
				expect(after.join("\n"), `${rel}: ${m[0]}`).toMatch(
					/\bAssert-Sha256\b/,
				);
			});
		}
		expect(found).toBeGreaterThan(0);
	});

	it("every tool of versions.toml is installed by a step through Get-ToolFile", () => {
		const used = new Set<string>();
		for (const s of scriptSteps())
			for (const m of code(read(`steps/${s}.ps1`)).matchAll(
				/Get-ToolFile\s+-Name\s+'([a-z]+)'/g,
			))
				used.add(m[1] as string);
		expect([...used].sort()).toEqual([...WINDOWS_TOOLS].sort());
	});

	it("the image does not run sysprep or seal, has no session task and writes no autologon", () => {
		for (const rel of ps1Files()) {
			const src = code(read(rel));
			expect(src, rel).not.toMatch(/sysprep\.exe|\bseal\b/i);
			expect(src, rel).not.toMatch(/\\sbx\\session|sbx-session/i);
			expect(src, rel).not.toMatch(
				/Set-RegValue[^\n]*(AutoAdminLogon|DefaultPassword|DefaultUserName)/,
			);
		}
	});
});

describe("windows steps: services", () => {
	it("lib.ps1 lists the services of section 8.1; 00-base leaves the update services to 90-cleanup", () => {
		const lib = read("lib.ps1");
		// dmwappushservice stays Manual through sysprep; specialize disables it on each clone.
		expect(SYSPREP_DEFERRED_SERVICES).toEqual(["dmwappushservice"]);
		expect(psArray(lib, "SbxDisabledServices").sort()).toEqual(
			DISABLED_SERVICES.filter(
				(s) => !SYSPREP_DEFERRED_SERVICES.includes(s),
			).sort(),
		);
		for (const s of ["00-base", "10-system", "90-cleanup"])
			expect(code(read(`steps/${s}.ps1`)), s).not.toMatch(/dmwappushservice/i);
		// verify runs on a clone, after the offline stage: everything is Disabled there.
		const verify = readFileSync(join(templates, "windows/verify.ps1"), "utf8");
		expect(psArray(verify, "DisabledServices").sort()).toEqual(
			[...DISABLED_SERVICES].sort(),
		);
		// DoSvc carries the Windows Update payloads of the OpenSSH FoD.
		expect(psArray(lib, "SbxUpdateServices").sort()).toEqual(
			["DoSvc", "UsoSvc", "wuauserv"].sort(),
		);
		const base = code(read("steps/00-base.ps1"));
		expect(base).toMatch(
			/\$SbxDisabledServices \| Where-Object \{ \$_ -notin \$SbxUpdateServices \}/,
		);
		const cleanup = code(read("steps/90-cleanup.ps1"));
		expect(cleanup).toMatch(/\$SbxUpdateServices/);
		expect(cleanup).toMatch(/\$SbxDisabledServices/);
	});

	it("VSS stays Manual for QGA fsfreeze", () => {
		expect(DISABLED_SERVICES).not.toContain("VSS");
		expect(code(read("steps/00-base.ps1"))).toMatch(
			/'VSS', 'swprv'[\s\S]*Manual/,
		);
	});
});

describe("windows steps: files/", () => {
	it("appx-remove.txt keeps Edge, Terminal, Notepad, Calculator, Paint, Snipping Tool, Photos, Store, App Installer", () => {
		const list = read("files/appx-remove.txt")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l !== "" && !l.startsWith("#"));
		expect(list.length).toBeGreaterThan(10);
		for (const p of list)
			for (const kept of KEPT_APPX)
				expect(appxMatch(p, kept), `${p} matches ${kept}`).toBe(false);
		for (const name of [
			"MSTeams",
			"Microsoft.OutlookForWindows",
			"Clipchamp.Clipchamp",
			"Microsoft.BingNews",
			"Microsoft.BingWeather",
			"Microsoft.GamingApp",
			"Microsoft.MicrosoftSolitaireCollection",
			"Microsoft.WindowsFeedbackHub",
			"Microsoft.GetHelp",
			"Microsoft.MicrosoftOfficeHub",
			"Microsoft.Todos",
			"Microsoft.Copilot",
		])
			expect(
				list.some((p) => appxMatch(p, name)),
				name,
			).toBe(true);
	});

	it("sshd_config listens on loopback only, certificates only", () => {
		const lines = read("files/sshd_config")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l !== "" && !l.startsWith("#"));
		expect(lines).toEqual(
			expect.arrayContaining([
				"ListenAddress 127.0.0.1",
				"ListenAddress ::1",
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"PubkeyAuthentication yes",
				"TrustedUserCAKeys __PROGRAMDATA__/ssh/sbx_user_ca.pub",
			]),
		);
		expect(lines.filter((l) => /^ListenAddress\b/i.test(l))).toHaveLength(2);
		expect(lines.filter((l) => /^PasswordAuthentication\b/i.test(l))).toEqual([
			"PasswordAuthentication no",
		]);
	});

	it("the local GPO runs sbx-agent early at startup", () => {
		const scripts = read("files/scripts.ini");
		expect(scripts).toMatch(/^\[Startup\]\r?$/m);
		// The wrapper survives a missing "current" junction.
		expect(scripts).toMatch(
			/^0CmdLine=C:\\Program Files\\sbx-agent\\sbx-early\.cmd\r?$/m,
		);
		expect(scripts).toMatch(/^0Parameters=\r?$/m);
		const gpt = read("files/gpt.ini");
		expect(gpt).toMatch(
			/^gPCMachineExtensionNames=\[\{42B5FAAE-6536-11D2-AE5A-0000F87571E3\}\{40B6664F-4972-11D1-A7CA-0000F87571E3\}\]\r?$/m,
		);
		expect(gpt).toMatch(/^Version=\d+\r?$/m);
	});

	it("sbx-early.cmd runs `early` from current, else previous, else the newest version", () => {
		const raw = readFileSync(join(shared, "files/sbx-early.cmd"), "utf8");
		expect(raw.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(
			true,
		);
		const c = code(raw);
		const at = (re: RegExp) => c.search(re);
		const cur = at(/exist "%SBX_DIR%current\\sbx-agent\.exe"/);
		const prev = at(/exist "%SBX_DIR%previous\\sbx-agent\.exe"/);
		const newest = at(/dir \/b \/ad \/o-d "%SBX_DIR%versions"/);
		const run = at(/^"%SBX_EXE%" early\r?$/m);
		expect(cur).toBeGreaterThanOrEqual(0);
		expect(prev).toBeGreaterThan(cur);
		expect(newest).toBeGreaterThan(prev);
		expect(run).toBeGreaterThan(newest);
		expect(c).toMatch(/exit \/b %errorlevel%\s*$/);
		expect(c).toMatch(
			/if not defined SBX_EXE \(\r?\n\s*echo[^\n]*\n\s*exit \/b 1/,
		);
	});

	it("profile.ps1 applies the agent env without executing it", () => {
		const p = code(read("files/profile.ps1"));
		expect(p).toMatch(/SBX_ENV_APPLIED/);
		expect(p).toMatch(/env --format pwsh/);
		expect(p).toMatch(/Parser\]::ParseInput/);
	});
});

describe("windows steps: step content", () => {
	it("10-system installs OpenSSH from the FoD, keeps sshd Manual, removes its firewall rule", () => {
		const s = code(read("steps/10-system.ps1"));
		expect(s).toMatch(/Add-WindowsCapability -Online -Name \$capability/);
		expect(s).toMatch(/'OpenSSH\.Server~~~~0\.0\.1\.0'/);
		expect(s).toMatch(/-StartupType Manual/);
		expect(s).toMatch(/OpenSSH-Server-In-TCP/);
		expect(s).toMatch(/DefaultShell/);
		expect(s).toMatch(/POWERSHELL_TELEMETRY_OPTOUT/);
	});

	it("50-sbx-agent installs the package, the startup script and the sysprep answers", () => {
		const s = code(read("steps/50-sbx-agent.ps1"));
		expect(s).toMatch(/'install-package', '--write-config', \$tar/);
		// The installer comes out of the package itself (Windows tar.exe).
		expect(s).toMatch(
			/tar\.exe'\) -ArgumentList @\('-xf', \$tar, '-C', \$unpack, 'sbx-agent\.exe'\)/,
		);
		expect(s).toMatch(/SyncForegroundPolicy/);
		// scripts.ini as Group Policy writes it: UTF-16 LE, CRLF.
		expect(s).toMatch(/-replace "`r\?`n", "`r`n"/);
		expect(s).toMatch(/scripts\.ini'\) -Value \$ini -Encoding Unicode/);
		// The wrapper goes next to the agent, CRLF, and is what the GPO must register.
		expect(s).toMatch(/'sbx-agent\\sbx-early\.cmd'/);
		expect(s).toMatch(/Where-Object \{ \$_ -eq \$earlyCmd \}/);
		expect(s).toMatch(/DelayedAutostart/);
		expect(s).toMatch(/gpupdate\.exe/);
		expect(s).toMatch(/QEMU-GA/);
		expect(s).toMatch(/sbx-unattend\.xml/);
	});

	it("90-cleanup keeps build.json and checks for leftovers", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		expect(s).toMatch(/sbx-template\\build\.json/);
		expect(s).not.toMatch(/Remove-Item[^\n]*sbx-template/);
		expect(s).toMatch(/StartComponentCleanup/);
		expect(s).toMatch(/authorized_keys/);
		expect(s).toMatch(/Panther/);
		// Self-check of what the image must not carry.
		expect(s).toMatch(/AutoAdminLogon/);
		expect(s).toMatch(
			/Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True/,
		);
		expect(s).toMatch(/Get-BitLockerStatus/);
	});

	it("90-cleanup refuses pending servicing before DISM", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		const pending = s.indexOf("Component Based Servicing\\RebootPending");
		expect(pending).toBeGreaterThan(0);
		expect(pending).toBeLessThan(s.indexOf("StartComponentCleanup"));
	});

	it("90-cleanup accepts DISM exit 0 only and fails on a reboot DISM left pending", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		const dism = s.indexOf("StartComponentCleanup");
		const call = s.slice(s.lastIndexOf("\n", dism), s.indexOf("\n", dism));
		expect(call).toMatch(/-SuccessCodes @\(0, 3010\) -PassThru/);
		const after = s.slice(dism);
		expect(after).toMatch(/-eq 3010\) \{ throw [^\n]*3010[^\n]*reboot/);
		// The same check as before DISM, failing right there with the key.
		const checks = [...s.matchAll(/Get-PendingReboot/g)].map((m) => m.index);
		expect(checks.filter((i) => i > dism).length).toBeGreaterThan(0);
		expect(checks.filter((i) => i < dism).length).toBeGreaterThan(1);
		expect(after).toMatch(
			/throw "DISM [^\n]*\$\(\$pending -join ', '\)[^\n]*reboot after 90-cleanup/,
		);
	});

	it("90-cleanup warns about Appx packages installed for a user but not provisioned", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		const start = s.indexOf(
			"$problems = [Collections.Generic.List[string]]::new()",
		);
		expect(start).toBeGreaterThan(0);
		const check = s.slice(start);
		expect(check).toMatch(/Get-AppxPackage -AllUsers/);
		expect(check).toMatch(/Get-AppxProvisionedPackage -Online/);
		expect(check).toMatch(
			/Write-BuildLog "WARNING: Appx [^\n]*not provisioned/,
		);
		// Informative only: never a problem of the self-check.
		expect(check).not.toMatch(/\$problems\.Add\([^\n]*[Aa]ppx/);
	});

	it("40-coding-agents protects the ProgramData config dirs (no Users write)", () => {
		const s = code(read("steps/40-coding-agents.ps1"));
		expect(s).toMatch(
			/function Protect-ConfigDir[\s\S]*'\/inheritance:r'[\s\S]*'\*S-1-5-18:\(OI\)\(CI\)F'[\s\S]*'\*S-1-5-32-544:\(OI\)\(CI\)F'[\s\S]*'\*S-1-5-32-545:\(OI\)\(CI\)RX'/,
		);
		expect(s).toMatch(/@\('opencode', 'OpenAI'\)\) \{ Protect-ConfigDir/);
		// The protection comes after the files are written and before the version probes.
		expect(s.indexOf("Protect-ConfigDir (Join-Path")).toBeGreaterThan(
			s.indexOf("OpenAI\\Codex\\config.toml"),
		);
		expect(s.indexOf("Protect-ConfigDir (Join-Path")).toBeLessThan(
			s.indexOf("Get-InstalledVersion $path"),
		);
	});

	it("40-coding-agents puts the gemini system settings under Program Files, not ProgramData", () => {
		const s = code(read("steps/40-coding-agents.ps1"));
		// gemini refuses a settings file whose parent lets Users create
		// folders, which C:\ProgramData does.
		expect(s).toMatch(
			/\$geminiSettings = Join-Path \$env:ProgramFiles 'gemini-cli\\settings\.json'/,
		);
		expect(s).toMatch(
			/Write-ConfigFile \$geminiSettings "\{ `"general`": \{ `"enableAutoUpdate`": false, `"enableAutoUpdateNotification`": false \} \}`n"/,
		);
		expect(s).toMatch(
			/Set-MachineEnv GEMINI_CLI_SYSTEM_SETTINGS_PATH \$geminiSettings/,
		);
		expect(s).toMatch(
			/Remove-Item -LiteralPath \(Join-Path \$env:ProgramData 'gemini-cli'\) -Recurse -Force/,
		);
		expect(s).not.toMatch(/ProgramData 'gemini-cli\\settings\.json'/);
		// The env is set before the version probes run.
		expect(s.indexOf("GEMINI_CLI_SYSTEM_SETTINGS_PATH")).toBeLessThan(
			s.indexOf("Get-InstalledVersion $path"),
		);
	});

	it("--version probes go through Invoke-Probe (stdin closed, time limit)", () => {
		for (const st of ["30-toolchains", "40-coding-agents"]) {
			const s = code(read(`steps/${st}.ps1`));
			expect(s, st).not.toMatch(/& \$\w+(\.Source)? (@\w+|--version)/);
			expect(s, st).not.toMatch(/function Get-InstalledVersion/);
		}
		expect(code(read("steps/40-coding-agents.ps1"))).toMatch(
			/Get-InstalledVersion \$path @\('--version'\)/,
		);
		expect(code(read("steps/30-toolchains.ps1"))).toMatch(
			/Invoke-Probe -FilePath \$npm -ArgumentList @\('prefix', '-g'\)/,
		);
		const lib = code(read("lib.ps1"));
		expect(lib).toMatch(/function Get-InstalledVersion[\s\S]*?Invoke-Probe/);
	});

	it("lib.ps1 retries a busy hive unload for about a minute", () => {
		const lib = code(read("lib.ps1"));
		const unload = lib.slice(
			lib.indexOf("function Invoke-WithDefaultUserHive"),
		);
		expect(unload).toMatch(/if \(\$i -ge 30\)/);
		expect(unload).toMatch(
			/Start-Sleep -Seconds 2\s+\[GC\]::Collect\(\)\s+\[GC\]::WaitForPendingFinalizers\(\)/,
		);
	});

	it("the recipe reboots after the last install step and before the agent is installed", () => {
		const steps = recipe().steps;
		const reboots = steps.flatMap((s, i) => (s === "reboot" ? [i] : []));
		const last = reboots.at(-1) ?? -1;
		expect(last).toBeGreaterThan(steps.indexOf("40-coding-agents"));
		// The agent service and its startup script must never run on the build VM.
		expect(last).toBeLessThan(steps.indexOf("50-sbx-agent"));
	});

	it("00-base keeps going when an Appx package or an Edge update task resists", () => {
		const s = code(read("steps/00-base.ps1"));
		expect(s).toMatch(
			/try \{\s*Remove-AppxProvisionedPackage[\s\S]*?\} catch \{/,
		);
		expect(s).toMatch(
			/MicrosoftEdgeUpdateTask[\s\S]*?try \{\s*Disable-ScheduledTask[\s\S]*?\} catch \{/,
		);
	});
});

describe("windows steps: build ISO", () => {
	it("carries lib.ps1, the steps and files/", () => {
		const r = recipe();
		const files = buildIsoFiles({
			recipe: r,
			versions: loadVersions(r),
			agentTar: Buffer.from("tar"),
			agentVersion: "0.4.0",
			agentToml: "",
			buildPassword: "pw",
			buildId: "0199c5a0-7b1e-7a3c-8d3e-5f2a9c1b4e60",
			productKey: null,
		});
		expect([...files.keys()]).toEqual(
			expect.arrayContaining([
				"build/lib.ps1",
				...scriptSteps().map((s) => `build/steps/${s}.ps1`),
				"build/files/appx-remove.txt",
				"build/files/sshd_config",
				"build/files/profile.ps1",
				"build/files/scripts.ini",
				"build/files/gpt.ini",
				"build/files/sbx-early.cmd",
				"build/files/firstboot.ps1",
				"build/files/SetupComplete-clone.cmd",
			]),
		);
	});
});

describe("windows steps: clone first boot", () => {
	it("00-base ignores local firewall rules through the policy of every profile", () => {
		const s = code(read("steps/00-base.ps1"));
		expect(s).toMatch(
			/foreach \(\$p in @\('DomainProfile', 'PrivateProfile', 'PublicProfile'\)\) \{\s*Set-RegValue "\$policies\\WindowsFirewall\\\$p" AllowLocalPolicyMerge 0/,
		);
	});

	it("firstboot.ps1 disables the services of lib.ps1, CDPSvc and dmwappushservice", () => {
		const lib = read("lib.ps1");
		const want = new Set([
			...psArray(lib, "SbxDisabledServices"),
			...psArray(lib, "SbxUpdateServices"),
			"CDPSvc",
			"dmwappushservice",
		]);
		const fb = read("files/firstboot.ps1");
		expect(psArray(fb, "Services").sort()).toEqual([...want].sort());
		expect(psArray(lib, "SbxDisabledServices")).toContain("CDPSvc");
	});

	it("firstboot.ps1 is self-contained 5.1, restores code pages, BCD, WinRE, NetBIOS, firewall policy", () => {
		const raw = read("files/firstboot.ps1");
		const s = code(raw);
		expect(raw.split(/\r?\n/, 1)[0]).not.toMatch(PWSH7_HEADER);
		expect(s).not.toMatch(/lib\.ps1/);
		expect(s).toMatch(
			/\[string\]\$LogPath = 'C:\\ProgramData\\sbx-template\\firstboot\.log'/,
		);
		expect(s).toMatch(/Control\\Nls\\CodePage/);
		expect(s).toMatch(/@\('ACP', 'OEMCP', 'MACCP'\)[\s\S]*'65001'/);
		expect(s).toMatch(/reagentc\.exe' @\('\/disable'\)/);
		expect(s).toMatch(/'\{current\}', 'recoveryenabled', 'no'/);
		expect(s).toMatch(/'\{current\}', 'bootstatuspolicy', 'ignoreallfailures'/);
		expect(s).toMatch(/NetbiosOptions/);
		expect(s).toMatch(/SetTcpipNetbios/);
		expect(s).toMatch(
			/@\('DomainProfile', 'PrivateProfile', 'PublicProfile'\)[\s\S]*AllowLocalPolicyMerge/,
		);
		// OOBE's AppX inbound allow rules are disabled in the local store.
		expect(s).toMatch(
			/Get-NetFirewallRule -PolicyStore PersistentStore -Direction Inbound -Action Allow -Enabled True[\s\S]*Disable-NetFirewallRule/,
		);
		expect(s).toMatch(/firewall: disabled \$\(\$rules\.Count\)/);
		// Never fails Setup.
		expect(s).not.toMatch(/\bexit [1-9]/);
		expect(s).not.toMatch(/\bthrow\b/);
		expect(s.trimEnd().split("\n").at(-1)).toBe("exit 0");
		// firstboot.done (a timestamp) is the last action: the agent waits
		// for it before the rename reboot.
		expect(s).toMatch(
			/\[string\]\$DonePath = 'C:\\ProgramData\\sbx-template\\firstboot\.done'/,
		);
		expect(s).toMatch(
			/Write-Log 'done'\s*try \{[^\n]*\n(\s+[^\n]*\n)*?\s+\[IO\.File\]::WriteAllText\(\$DonePath, \(Get-Date\)\.ToUniversalTime\(\)\.ToString\('o'\)\)\s*\} catch \{\s*Write-Log "ERROR done marker: [^\n]*"\s*\}\s*exit 0\s*$/,
		);
	});

	it("firstboot.ps1 exits 0, ends its log with done and writes firstboot.done even when every part fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-firstboot-"));
		try {
			const log = join(dir, "firstboot.log");
			const done = join(dir, "marker", "firstboot.done");
			const r = spawnSync(
				PWSH,
				[
					"-NoProfile",
					"-NonInteractive",
					"-File",
					join(shared, "files/firstboot.ps1"),
					"-LogPath",
					log,
					"-DonePath",
					done,
				],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			expect(r.status, r.stdout + r.stderr).toBe(0);
			const lines = readFileSync(log, "utf8").trimEnd().split(/\r?\n/);
			expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\] start/);
			expect(lines.at(-1)).toMatch(/^\[\d\d:\d\d:\d\d\] done$/);
			// Off Windows every part fails, and each failure is logged.
			expect(lines.some((l) => / ERROR /.test(l))).toBe(true);
			// The done marker is written even after failed parts.
			const stamp = readFileSync(done, "utf8").trim();
			expect(stamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
			expect(Number.isNaN(Date.parse(stamp))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("SetupComplete-clone.cmd (CRLF) runs firstboot.ps1 with Windows PowerShell and never fails", () => {
		const raw = read("files/SetupComplete-clone.cmd");
		expect(raw.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(
			true,
		);
		expect(raw).toMatch(
			/^"%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\ProgramData\\sbx-template\\firstboot\.ps1"\r$/m,
		);
		expect(raw.trimEnd().split(/\r?\n/).at(-1)).toBe("exit /b 0");
	});

	it("90-cleanup replaces the build SetupComplete.cmd with the clone's and installs firstboot.ps1", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		const removed = s.indexOf("'Setup\\Scripts\\SetupComplete.cmd'");
		expect(removed).toBeGreaterThan(0);
		const install = s.indexOf("SetupComplete-clone.cmd");
		expect(install).toBeGreaterThan(removed);
		expect(s.slice(install)).toMatch(
			/-replace "`r\?`n", "`r`n"[\s\S]*Set-Content -LiteralPath \$setupComplete[^\n]*-Encoding Ascii -NoNewline/,
		);
		expect(s).toMatch(
			/\$setupComplete = Join-Path \$env:SystemRoot 'Setup\\Scripts\\SetupComplete\.cmd'/,
		);
		expect(s).toMatch(
			/\$firstBoot = Join-Path \$env:ProgramData 'sbx-template\\firstboot\.ps1'/,
		);
		expect(s).toMatch(
			/Copy-BuildFile -Name 'firstboot\.ps1' -Destination \$firstBoot/,
		);
		expect(s).toMatch(
			/icacls\.exe -ArgumentList @\(\$firstBoot, '\/inheritance:r', '\/grant:r', '\*S-1-5-18:F', '\/grant:r', '\*S-1-5-32-544:F', '\/grant:r', '\*S-1-5-32-545:R'\)/,
		);
		// The self-check sees both.
		const check = s.slice(
			s.indexOf("$problems = [Collections.Generic.List[string]]::new()"),
		);
		expect(check).toMatch(/\$setupComplete/);
		expect(check).toMatch(/\$firstBoot/);
	});

	it("90-cleanup leaves no firstboot.done in the image (the agent waits for it on the clone)", () => {
		const s = code(read("steps/90-cleanup.ps1"));
		expect(s).toMatch(
			/\$firstBootDone = Join-Path \$env:ProgramData 'sbx-template\\firstboot\.done'/,
		);
		expect(s).toMatch(/Remove-Leftover \$firstBootDone/);
		const check = s.slice(
			s.indexOf("$problems = [Collections.Generic.List[string]]::new()"),
		);
		expect(check).toMatch(
			/if \(Test-Path -LiteralPath \$firstBootDone\) \{ \$problems\.Add\("\$firstBootDone exists"\) \}/,
		);
	});
});

/** pwsh comes from mise.toml (`powershell`); `PWSH=<path>` overrides it. */
const PWSH = process.env.PWSH ?? "pwsh";

describe("windows steps: PowerShell parser", () => {
	it("pwsh is available (mise.toml powershell)", () => {
		const r = spawnSync(PWSH, ["-NoProfile", "-Command", "exit 0"]);
		expect(r.error, `${PWSH}: run the tests through mise`).toBeUndefined();
		expect(r.status).toBe(0);
	});

	it("profile.ps1 applies exactly the two env line forms and ignores everything else", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-profile-"));
		try {
			const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
			const out = [
				"$env:SBX_T_PLAIN = 'it''s plain'",
				`$env:SBX_T_B64 = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64("line1\nline2 \u00e9")}'))`,
				'$env:SBX_T_DOUBLE = "expanded $env:HOME"',
				"$env:SBX_T_HERE = @'\nx\n'@",
				"$" + "{env:SBX_T-BAD} = 'braced name'",
				"$env:1BAD = 'digit first'",
				"$env:SBX_T_CMD = (Get-Date).ToString()",
				`$env:SBX_T_OTHER = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64("x")}')) + 'tail'`,
				"$env:SBX_T_STATIC = [System.Environment]::MachineName",
				"$script:SBX_T_VAR = 'not env'",
				"Set-Content -LiteralPath SBX_T_MARK -Value x",
			];
			const agent = join(dir, "sbx-agent");
			writeFileSync(
				agent,
				`#!/bin/sh\ncat <<'EOF_SBX'\n${out.join("\n")}\nEOF_SBX\n`,
				{ mode: 0o755 },
			);
			const profile = read("files/profile.ps1").replace(
				"'C:\\Program Files\\sbx-agent\\current\\sbx-agent.exe'",
				`'${agent}'`,
			);
			expect(profile).toContain(agent);
			const script = join(dir, "run.ps1");
			writeFileSync(
				script,
				`Set-Location '${dir}'
. '${join(dir, "profile.ps1")}'
foreach ($n in 'SBX_T_PLAIN','SBX_T_B64','SBX_T_DOUBLE','SBX_T_HERE','SBX_T_CMD','SBX_T_OTHER','SBX_T_STATIC','SBX_T_VAR') {
  $v = [Environment]::GetEnvironmentVariable($n)
  Write-Output ($n + '=' + $(if ($null -eq $v) { '<unset>' } else { $v.Replace("\`n", '|') }))
}
Write-Output ('applied=' + $env:SBX_ENV_APPLIED)
Write-Output ('mark=' + (Test-Path -LiteralPath (Join-Path '${dir}' 'SBX_T_MARK')))
`,
			);
			writeFileSync(join(dir, "profile.ps1"), profile);
			const r = spawnSync(
				PWSH,
				["-NoProfile", "-NonInteractive", "-File", script],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			expect(r.stderr).toBe("");
			expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual([
				"SBX_T_PLAIN=it's plain",
				"SBX_T_B64=line1|line2 \u00e9",
				"SBX_T_DOUBLE=<unset>",
				"SBX_T_HERE=<unset>",
				"SBX_T_CMD=<unset>",
				"SBX_T_OTHER=<unset>",
				"SBX_T_STATIC=<unset>",
				"SBX_T_VAR=<unset>",
				"applied=1",
				"mark=False",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("every .ps1 parses without errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-ps-parse-"));
		try {
			const script = join(dir, "parse.ps1");
			writeFileSync(
				script,
				`$bad = 0
foreach ($f in $args) {
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
  foreach ($e in $errs) { Write-Output "\${f}:$($e.Extent.StartLineNumber): $($e.Message)"; $bad++ }
}
exit $bad
`,
			);
			const files = ps1Files().map((rel) => join(shared, rel));
			const r = spawnSync(
				PWSH,
				["-NoProfile", "-NonInteractive", "-File", script, ...files],
				{ encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
			);
			expect(r.stdout + r.stderr).toBe("");
			expect(r.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Runs `body` in pwsh after dot-sourcing lib.ps1; returns the exit status and output. */
function runWithLib(body: string): { status: number | null; out: string } {
	const dir = mkdtempSync(join(tmpdir(), "sbx-lib-"));
	try {
		writeFileSync(join(dir, "lib.ps1"), read("lib.ps1"));
		const script = join(dir, "t.ps1");
		writeFileSync(script, `. (Join-Path $PSScriptRoot 'lib.ps1')\n${body}\n`);
		const r = spawnSync(
			PWSH,
			["-NoProfile", "-NonInteractive", "-File", script],
			{
				encoding: "utf8",
				env: { ...process.env, NO_COLOR: "1", SBX_BUILD_DIR: dir },
			},
		);
		return { status: r.status, out: r.stdout + r.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("lib.ps1 (pwsh)", () => {
	it("Invoke-Installer retries MSI exit 1618 three times, 30 s apart", () => {
		const mock = (codes: number[]) => `$script:codes = @(${codes.join(", ")})
$script:runs = 0
function Start-Process { $script:runs++; [pscustomobject]@{ ExitCode = $script:codes[$script:runs - 1] } }
function Start-Sleep([int]$Seconds) { Write-Output "sleep $Seconds" }`;
		const ok = runWithLib(`${mock([1618, 1618, 1618, 0])}
Invoke-Installer -FilePath 'x.exe' -Arguments '/qn'
Write-Output "runs $script:runs"`);
		expect(ok.status, ok.out).toBe(0);
		expect(ok.out.match(/sleep 30/g)).toHaveLength(3);
		expect(ok.out).toContain("runs 4");

		const busy = runWithLib(`${mock([1618, 1618, 1618, 1618, 0])}
try { Invoke-Installer -FilePath 'x.exe' -Arguments '/qn' } catch { Write-Output "failed: $($_.Exception.Message)" }
Write-Output "runs $script:runs"`);
		expect(busy.out).toMatch(/failed: x\.exe: exit code 1618/);
		expect(busy.out).toContain("runs 4");

		const other = runWithLib(`${mock([1603])}
try { Invoke-Installer -FilePath 'x.exe' -Arguments '/qn' } catch { Write-Output "failed: $($_.Exception.Message)" }
Write-Output "runs $script:runs"`);
		expect(other.out).toMatch(/failed: x\.exe: exit code 1603/);
		expect(other.out).toContain("runs 1");
	});

	it("Invoke-Probe closes stdin, returns the output and the exit code", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-probe-"));
		try {
			const tool = join(dir, "tool");
			// Waits for stdin like a CLI that prompts: EOF lets it go on at once.
			writeFileSync(
				tool,
				'#!/bin/sh\nread x\necho "tool 1.2.3 $1"\necho warn >&2\nexit 3\n',
				{ mode: 0o755 },
			);
			const r =
				runWithLib(`$r = Invoke-Probe -FilePath '${tool}' -ArgumentList @('--version') -TimeoutSec 20
Write-Output "exit $($r.ExitCode)"
Write-Output "out $($r.Output -join '|')"
Write-Output "err $($r.Errors -join '|')"`);
			expect(r.status, r.out).toBe(0);
			expect(r.out).toContain("exit 3");
			expect(r.out).toContain("out tool 1.2.3 --version");
			expect(r.out).toContain("err warn");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Invoke-Probe kills a tool that does not exit in time, with its children", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-probe-"));
		try {
			const tool = join(dir, "hang");
			const pidFile = join(dir, "child.pid");
			writeFileSync(
				tool,
				`#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`,
				{ mode: 0o755 },
			);
			const started = Date.now();
			const r = runWithLib(`try {
    Invoke-Probe -FilePath '${tool}' -ArgumentList @('--version') -TimeoutSec 2 | Out-Null
    Write-Output 'no error'
} catch { Write-Output "failed: $($_.Exception.Message)" }`);
			expect(Date.now() - started).toBeLessThan(20_000);
			expect(r.out).toMatch(/failed: .*hang --version: no exit within 2 s/);
			const child = Number(readFileSync(pidFile, "utf8").trim());
			let alive = true;
			try {
				process.kill(child, 0);
			} catch {
				alive = false;
			}
			expect(alive).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("run-step.ps1 (pwsh)", () => {
	it("a log write blocked by another handle never fails the step; the line is written later", () => {
		const dir = mkdtempSync(join(tmpdir(), "sbx-run-step-"));
		try {
			const logs = join(dir, "logs");
			const wrapper = read("run-step.ps1");
			const patched = wrapper
				.replace("$logDir = 'C:\\sbx-build\\logs'", `$logDir = '${logs}'`)
				.replace("$logRetries = 40", "$logRetries = 3")
				.replace("$logRetryMs = 250", "$logRetryMs = 50");
			expect(patched).toContain(`$logDir = '${logs}'`);
			expect(patched).toContain("$logRetries = 3");
			expect(patched).toContain("$logRetryMs = 50");
			mkdirSync(join(dir, "build", "steps"), { recursive: true });
			writeFileSync(join(dir, "build", "run-step.ps1"), patched);
			// The step holds the log without any sharing (an exclusive flock on Unix) longer than
			// the wrapper retries, prints a line meanwhile, then lets go.
			writeFileSync(
				join(dir, "build", "steps", "t.ps1"),
				`#requires -Version 7
$h = [System.IO.File]::Open($env:SBX_TEST_LOG, 'Open', 'ReadWrite', 'None')
Write-Output 'during-lock'
Start-Sleep -Milliseconds 1500
$h.Dispose()
Write-Output 'after-lock'
exit 0
`,
			);
			// run-step.ps1 finds pwsh 7 at $env:ProgramFiles\PowerShell\7\pwsh.exe.
			const exe = join(dir, "pf", "PowerShell", "7", "pwsh.exe");
			mkdirSync(join(dir, "pf", "PowerShell", "7"), { recursive: true });
			const real = spawnSync(
				PWSH,
				["-NoProfile", "-Command", "[Environment]::ProcessPath"],
				{ encoding: "utf8" },
			).stdout.trim();
			writeFileSync(exe, `#!/bin/sh\nexec '${real}' "$@"\n`);
			chmodSync(exe, 0o755);

			const r = spawnSync(
				PWSH,
				[
					"-NoProfile",
					"-NonInteractive",
					"-File",
					join(dir, "build", "run-step.ps1"),
					"-Step",
					"t",
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						NO_COLOR: "1",
						ProgramFiles: join(dir, "pf"),
						SBX_TEST_LOG: join(logs, "t.log"),
					},
				},
			);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(readFileSync(join(logs, "t.exit"), "utf8")).toBe("0");
			const lines = readFileSync(join(logs, "t.log"), "utf8").split("\n");
			expect(lines.filter((l) => !l.startsWith("run-step:"))).toEqual([
				"during-lock",
				"after-lock",
				"",
			]);
			expect(lines.at(-2)).toBe("run-step: t: exit code 0");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
