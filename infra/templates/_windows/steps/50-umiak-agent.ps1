#requires -Version 7
# 50-umiak-agent (spec S9 sections 8.4, 8.6, 12.1-12.3): the agent package
# through its own installer, agent.toml, the template SSH CA, PowerShell
# profiles, the startup script (the wrapper umiak-early.cmd, which runs
# `umiak-agent early`) in the local GPO, QGA and its VSS provider, the sysprep
# answer file for clones. The service is installed,
# not started: it would treat the build VM as a new machine.
. (Join-Path $PSScriptRoot '..\lib.ps1')

$agentData = Join-Path $env:ProgramData 'umiak-agent'
$versions = Get-BuildVersionInfo
$tar = Join-Path $UmiakBuildDir $versions.agent.package
if (-not (Test-Path -LiteralPath $tar)) { throw "$tar not found" }
$trustKeys = Join-Path $UmiakBuildDir 'update-keys.pub'
if (-not (Test-Path -LiteralPath $trustKeys)) { throw "$trustKeys not found" }

# --- agent.toml first: --write-config keeps an existing file ---
New-Item -ItemType Directory -Force -Path $agentData | Out-Null
# ProgramData lets users add files; only SYSTEM and Administrators write here.
Invoke-Native -FilePath icacls.exe -ArgumentList @($agentData, '/inheritance:r', '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', '/grant', '*S-1-5-32-545:(OI)(CI)RX')
Copy-Item -LiteralPath (Join-Path $UmiakBuildDir 'agent.toml') -Destination (Join-Path $agentData 'agent.toml') -Force
# Template CA keys (may be empty); identity apply copies them to C:\ProgramData\ssh\umiak_user_ca.pub.
Copy-Item -LiteralPath (Join-Path $UmiakBuildDir 'ssh-user-ca.pub') -Destination (Join-Path $agentData 'ssh-user-ca.pub') -Force

# --- The package installs itself: run umiak-agent.exe from the tar ---
# The builder verified the package signature before the build (spec S9 7 p.1).
# --trust-keys: the update keys the builder verified the package with, from the
# build ISO, are the first-install trust anchor instead of the keys embedded in
# the binary (a homelab install signs with its own key). The installed version's
# trust\update-keys.pub verifies later updates.
$unpack = Join-Path $UmiakWorkDir 'agent-installer'
if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
New-Item -ItemType Directory -Force -Path $unpack | Out-Null
Invoke-Native -FilePath (Join-Path $env:SystemRoot 'System32\tar.exe') -ArgumentList @('-xf', $tar, '-C', $unpack, 'umiak-agent.exe')
Invoke-Native -FilePath (Join-Path $unpack 'umiak-agent.exe') -ArgumentList @('install-package', '--write-config', '--trust-keys', $trustKeys, $tar)
Remove-Item -LiteralPath $unpack -Recurse -Force
if (-not (Test-Path -LiteralPath $UmiakAgentExe)) { throw "$UmiakAgentExe is missing after install-package" }
Update-SessionPath

$svc = Get-Service -Name 'umiak-agent'
if ($svc.StartType -ne 'Automatic') { throw "service umiak-agent is $($svc.StartType), want Automatic" }
# Automatic, not Automatic (Delayed Start): the agent starts with the startup script (spec 12.2).
$delayed = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\umiak-agent').PSObject.Properties['DelayedAutostart']
if ($delayed -and $delayed.Value -ne 0) { throw "service umiak-agent has DelayedAutostart=$($delayed.Value), want 0" }

# A template must carry a production agent build (spec S3 17.6).
$doctor = (Get-NativeOutput -FilePath $UmiakAgentExe -ArgumentList @('doctor', '--json')) -join "`n" | ConvertFrom-Json
$current = [string]$doctor.versions.current
if ($current -ne $versions.agent.version) { throw "agent current is '$current', want $($versions.agent.version)" }
# test_aids is omitted when empty.
$aidsProp = $doctor.PSObject.Properties['test_aids']
# @() around the if: an empty array result is unrolled to $null otherwise.
$aids = @(if ($aidsProp) { $aidsProp.Value | Where-Object { $_ } })
if ($aids.Count -gt 0) { throw "agent has test aids: $($aids -join ', ')" }
Write-BuildLog "agent $current, test_aids none"

# --- PowerShell profiles (AllUsersAllHosts) of pwsh 7 and 5.1 ---
$ps51Home = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0'
foreach ($psHomeDir in @((Split-Path -Parent $UmiakPwshExe), $ps51Home)) {
    Copy-BuildFile -Name 'profile.ps1' -Destination (Join-Path $psHomeDir 'profile.ps1')
}
# Profiles and the npm .ps1 shims need local scripts allowed: the client
# default of 5.1 is Restricted (pwsh 7 defaults to RemoteSigned already).
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\PowerShell\1\ShellIds\Microsoft.PowerShell' ExecutionPolicy 'RemoteSigned' String

# --- Local GPO: computer startup script `umiak-agent.exe early` (spec 12.3) ---
# The GPO runs a wrapper, not current\umiak-agent.exe: it finds the agent when the "current"
# junction is missing (an interrupted update).
$earlyCmd = Join-Path $env:ProgramFiles 'umiak-agent\umiak-early.cmd'
$earlyText = (Get-Content -LiteralPath (Join-Path $UmiakFilesDir 'umiak-early.cmd') -Raw) -replace "`r?`n", "`r`n"
Set-Content -LiteralPath $earlyCmd -Value $earlyText -Encoding Ascii -NoNewline
$gpo = Join-Path $env:SystemRoot 'System32\GroupPolicy'
$startupDir = Join-Path $gpo 'Machine\Scripts\Startup'
New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $gpo 'Machine\Scripts\Shutdown') | Out-Null
# Group Policy writes scripts.ini as UTF-16 LE with CRLF.
$ini = (Get-Content -LiteralPath (Join-Path $UmiakFilesDir 'scripts.ini') -Raw) -replace "`r?`n", "`r`n"
Set-Content -LiteralPath (Join-Path $gpo 'Machine\Scripts\scripts.ini') -Value $ini -Encoding Unicode -NoNewline
# gpt.ini: the scripts client-side extension next to the ones already there;
# the version only grows, so the client sees a changed GPO.
$gptPath = Join-Path $gpo 'gpt.ini'
$template = Get-Content -LiteralPath (Join-Path $UmiakFilesDir 'gpt.ini')
$extensions = [Collections.Generic.SortedSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$version = [int64]0
$lines = @(if (Test-Path -LiteralPath $gptPath) { Get-Content -LiteralPath $gptPath }) + $template
foreach ($line in $lines) {
    if ($line -match '^gPCMachineExtensionNames=(.*)$') {
        foreach ($m in [regex]::Matches($Matches[1], '\[[^\]]*\]')) { [void]$extensions.Add($m.Value.ToUpperInvariant()) }
    } elseif ($line -match '^Version=(\d+)$') {
        $version = [Math]::Max($version, [int64]$Matches[1])
    }
}
$gpt = "[General]`r`ngPCMachineExtensionNames=$($extensions -join '')`r`nVersion=$($version + 1)`r`n"
Set-Content -LiteralPath $gptPath -Value $gpt -Encoding Ascii -NoNewline
Write-BuildLog "gpt.ini: Version=$($version + 1)"
# Startup scripts finish before logon (also before autologon).
Set-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\CurrentVersion\Winlogon' SyncForegroundPolicy 1
Invoke-Native -FilePath (Join-Path $env:SystemRoot 'System32\gpupdate.exe') -ArgumentList @('/target:computer', '/force')
# The scripts extension records what runs at the next startup.
$registered = @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Group Policy\Scripts\Startup' -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $_.GetValue('Script') } | Where-Object { $_ -eq $earlyCmd })
if ($registered.Count -eq 0) { throw "startup script $earlyCmd is not registered after gpupdate" }
Write-BuildLog "startup script: $earlyCmd (umiak-agent early)"

# --- QEMU guest agent and its VSS provider (QGA fsfreeze, spec 12.10) ---
Set-UmiakServiceStartup -Name 'QEMU-GA' -StartupType Automatic
$providers = Get-NativeOutput -FilePath vssadmin.exe -ArgumentList @('list', 'providers')
if (-not ($providers -match 'QEMU Guest Agent VSS Provider')) {
    $providers | ForEach-Object { Write-Host $_ }
    throw 'the QEMU Guest Agent VSS provider is not registered'
}
Write-BuildLog 'QEMU Guest Agent VSS Provider registered'

# --- Sysprep answers for clones (spec 10.2) ---
Copy-Item -LiteralPath (Join-Path $UmiakBuildDir 'umiak-unattend.xml') -Destination (Join-Path $env:SystemRoot 'System32\Sysprep\umiak-unattend.xml') -Force
Write-BuildLog 'umiak-unattend.xml in place'
Write-BuildLog 'done'
