#requires -Version 7
# 40-coding-agents (spec S9 section 8.5): global npm CLIs with the exact
# versions of versions.json npm (S5 versions.toml [npm]) into C:\ProgramData\npm,
# auto-update off through each vendor's system-wide config (as S5, see
# apps/template-builder/README.md).
. (Join-Path $PSScriptRoot '..\lib.ps1')

Update-SessionPath
$npm = Assert-Command 'npm.cmd'
# The cache goes with C:\sbx-build, not into the SYSTEM profile.
$env:npm_config_cache = Join-Path $SbxWorkDir 'npm-cache'
$env:npm_config_update_notifier = 'false'
$env:npm_config_fund = 'false'
$env:npm_config_audit = 'false'

# npm checks each tarball against the integrity of the registry.
$pkgs = @((Get-BuildVersionInfo).npm.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" })
if ($pkgs.Count -eq 0) { throw 'versions.json npm is empty' }
for ($i = 1; ; $i++) {
    try {
        Invoke-Native -FilePath $npm -ArgumentList (@('install', '-g', '--no-audit', '--no-fund') + $pkgs)
        break
    } catch {
        if ($i -ge 3) { throw }
        Write-BuildLog "npm install failed: $($_.Exception.Message); retrying in 30 s"
        Start-Sleep -Seconds 30
    }
}

function Write-ConfigFile([string]$Path, [string]$Content) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
    Write-BuildLog "$Path written"
}

# ProgramData dirs inherit write access for Users. Only SYSTEM and Administrators
# write; Users read and execute.
function Protect-ConfigDir([string]$Dir) {
    Invoke-Native -FilePath icacls.exe -ArgumentList @($Dir, '/inheritance:r', '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', '/grant', '*S-1-5-32-545:(OI)(CI)RX')
    foreach ($f in Get-ChildItem -LiteralPath $Dir -Recurse -File -Force) {
        Invoke-Native -FilePath icacls.exe -ArgumentList @($f.FullName, '/inheritance:r', '/grant', '*S-1-5-18:F', '/grant', '*S-1-5-32-544:F', '/grant', '*S-1-5-32-545:RX')
    }
}

# Claude Code: managed settings (Program Files on Windows) and the env switch.
Write-ConfigFile (Join-Path $env:ProgramFiles 'ClaudeCode\managed-settings.json') "{ `"env`": { `"DISABLE_AUTOUPDATER`": `"1`" } }`n"
Set-MachineEnv DISABLE_AUTOUPDATER 1
# Gemini CLI: system settings. gemini refuses its default C:\ProgramData\gemini-cli\settings.json
# because C:\ProgramData lets Users create folders ("Parent directory is insecure") and prints
# that warning before its version; Program Files is admin-only, the env names the file.
$geminiSettings = Join-Path $env:ProgramFiles 'gemini-cli\settings.json'
Write-ConfigFile $geminiSettings "{ `"general`": { `"enableAutoUpdate`": false, `"enableAutoUpdateNotification`": false } }`n"
Set-MachineEnv GEMINI_CLI_SYSTEM_SETTINGS_PATH $geminiSettings
Remove-Item -LiteralPath (Join-Path $env:ProgramData 'gemini-cli') -Recurse -Force -ErrorAction SilentlyContinue
# OpenCode: managed config dir and the env switch.
Write-ConfigFile (Join-Path $env:ProgramData 'opencode\opencode.json') "{ `"autoupdate`": false }`n"
Set-MachineEnv OPENCODE_DISABLE_AUTOUPDATE 1
# Codex: system config.
Write-ConfigFile (Join-Path $env:ProgramData 'OpenAI\Codex\config.toml') "# System config of the Codex CLI: versions come with the template build.`ncheck_for_update_on_startup = false`n"

foreach ($d in @('opencode', 'OpenAI')) { Protect-ConfigDir (Join-Path $env:ProgramData $d) }

$npmPrefix = Join-Path $env:ProgramData 'npm'
foreach ($t in @('claude', 'codex', 'opencode', 'gemini')) {
    $path = Assert-Command $t
    if (-not $path.StartsWith("$npmPrefix\", [StringComparison]::OrdinalIgnoreCase)) { throw "$t resolves to $path, want $npmPrefix" }
    # A CLI that waits for input or a network call fails the step after 120 s.
    Write-BuildLog "${t}: $(Get-InstalledVersion $path @('--version'))"
}
Write-BuildLog 'done'
