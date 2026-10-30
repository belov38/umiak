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
		for (const rel of [
			...ps1Files(),
			"files/scripts.ini",
			"files/gpt.ini",
			"files/sbx-early.cmd",
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
		expect(psArray(lib, "SbxDisabledServices").sort()).toEqual(
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
			]),
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
