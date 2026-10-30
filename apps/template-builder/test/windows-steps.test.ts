import { spawnSync } from "node:child_process";
import {
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
import { buildIsoFiles } from "../src/windows/media.ts";

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
		for (const rel of [...ps1Files(), "files/scripts.ini", "files/gpt.ini"])
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
		expect(psArray(lib, "SbxDisabledServices").sort()).toEqual(
			[...DISABLED_SERVICES].sort(),
		);
		expect(psArray(lib, "SbxUpdateServices").sort()).toEqual(
			["UsoSvc", "wuauserv"].sort(),
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
		expect(scripts).toMatch(
			/^0CmdLine=C:\\Program Files\\sbx-agent\\current\\sbx-agent\.exe\r?$/m,
		);
		expect(scripts).toMatch(/^0Parameters=early\r?$/m);
		const gpt = read("files/gpt.ini");
		expect(gpt).toMatch(
			/^gPCMachineExtensionNames=\[\{42B5FAAE-6536-11D2-AE5A-0000F87571E3\}\{40B6664F-4972-11D1-A7CA-0000F87571E3\}\]\r?$/m,
		);
		expect(gpt).toMatch(/^Version=\d+\r?$/m);
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
			]),
		);
	});
});

/** `PWSH=<path>` points at a pwsh outside PATH (e.g. `mise which pwsh --tool powershell`). */
const PWSH = process.env.PWSH ?? "pwsh";
const pwsh = spawnSync(PWSH, ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe("windows steps: PowerShell parser", () => {
	it.skipIf(!pwsh)("every .ps1 parses without errors", () => {
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
