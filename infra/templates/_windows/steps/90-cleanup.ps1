#requires -Version 7
# 90-cleanup (spec S9 section 8.8): update services off, component store
# (after the recipe's reboot: pending servicing makes DISM fail with 0x800f0806;
# DISM must not leave a reboot pending either, sysprep follows without one),
# downloads and caches, answer files with the build password, the clone's
# SetupComplete.cmd and firstboot.ps1, event logs, TRIM, then a self-check.
# The builder wrote C:\ProgramData\sbx-template\build.json right before this
# step (it stays) and removes C:\sbx-build after reading this log; it runs
# `sbx-agent seal` and sysprep itself.
. (Join-Path $PSScriptRoot '..\lib.ps1')

# Removes a path; files in use (Temp) are reported, not fatal.
function Remove-Leftover([string]$Path) {
    $items = @(Get-Item -Path $Path -Force -ErrorAction SilentlyContinue)
    foreach ($item in $items) {
        try {
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
        } catch {
            Write-BuildLog "WARNING: ${item}: $($_.Exception.Message)"
        }
    }
    if ($items.Count -gt 0) { Write-BuildLog "removed $Path ($($items.Count))" }
}

$manifest = Join-Path $env:ProgramData 'sbx-template\build.json'
if (-not (Test-Path -LiteralPath $manifest)) { throw "$manifest is missing: the builder writes it before this step" }

# Keys of servicing operations that finish at the next boot.
function Get-PendingReboot {
    return @(@(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\PackagesPending',
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
        ) | Where-Object { Test-Path -LiteralPath $_ })
}

# The FoD and the MSIs leave servicing operations that finish at the next boot.
$pending = @(Get-PendingReboot)
if ($pending.Count -gt 0) {
    throw "a reboot is pending ($($pending -join ', ')): the recipe needs a reboot step after the last install step, before 90-cleanup"
}

# --- Windows Update services: the FoD is installed ---
foreach ($s in $SbxUpdateServices) { Disable-SbxService -Name $s -StopNow }

# --- Component store ---
# Sysprep follows this step without a reboot: DISM must not leave one pending.
$dismCode = Invoke-Native -FilePath (Join-Path $env:SystemRoot 'System32\Dism.exe') -ArgumentList @('/Online', '/Cleanup-Image', '/StartComponentCleanup', '/ResetBase') -SuccessCodes @(0, 3010) -PassThru
if ($dismCode -eq 3010) { throw 'DISM /StartComponentCleanup /ResetBase: exit code 3010 (a reboot is required), and there is no reboot after 90-cleanup before sysprep' }
$pending = @(Get-PendingReboot)
if ($pending.Count -gt 0) {
    throw "DISM /StartComponentCleanup /ResetBase left a reboot pending ($($pending -join ', ')): a reboot after 90-cleanup is not allowed (sysprep follows)"
}

# --- Downloads, installers, caches (of SYSTEM, which ran the steps) ---
$sysProfile = Join-Path $env:SystemRoot 'System32\config\systemprofile'
foreach ($p in @(
        $SbxWorkDir,
        (Join-Path $env:SystemRoot 'Temp\*'),
        (Join-Path $env:SystemRoot 'SoftwareDistribution\Download\*'),
        (Join-Path $sysProfile 'AppData\Local\npm-cache'),
        (Join-Path $sysProfile 'AppData\Roaming\npm-cache'),
        (Join-Path $sysProfile 'AppData\Local\pip\cache'),
        (Join-Path $sysProfile 'AppData\Local\uv\cache'),
        (Join-Path $sysProfile 'AppData\Local\go-build'),
        (Join-Path $sysProfile 'go\pkg\mod'),
        (Join-Path $sysProfile 'AppData\Local\Temp\*'),
        # State of the CLIs' --version probes run as SYSTEM.
        (Join-Path $sysProfile '.claude*'),
        (Join-Path $sysProfile '.codex'),
        (Join-Path $sysProfile '.gemini'),
        (Join-Path $sysProfile '.config\opencode'),
        (Join-Path $sysProfile '.local\share\opencode'),
        (Join-Path $sysProfile '.local\state\opencode'),
        (Join-Path $sysProfile '.cache\opencode'),
        (Join-Path $sysProfile '.npm'))) {
    Remove-Leftover $p
}
# Installer payloads cached by bundles (Python) during the build steps: the
# subdirectories of Package Cache created after 00-base started.
$buildStart = (Get-Item -LiteralPath (Join-Path $SbxLogDir '00-base.log')).CreationTimeUtc
$packageCache = Join-Path $env:ProgramData 'Package Cache'
foreach ($d in @(Get-ChildItem -LiteralPath $packageCache -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.CreationTimeUtc -ge $buildStart })) {
    Remove-Leftover $d.FullName
}

# --- Answer files: the build password is in the cached autounattend ---
foreach ($p in @(
        (Join-Path $env:SystemRoot 'Panther\unattend*.xml'),
        (Join-Path $env:SystemRoot 'Panther\autounattend*.xml'),
        (Join-Path $env:SystemRoot 'Panther\Unattend'),
        (Join-Path $env:SystemRoot 'System32\Sysprep\unattend*.xml'),
        (Join-Path $env:SystemRoot 'System32\Sysprep\Panther\unattend*.xml'),
        # The build one would run again at the end of every clone's setup.
        (Join-Path $env:SystemRoot 'Setup\Scripts\SetupComplete.cmd'))) {
    Remove-Leftover $p
}

# --- Clone first boot: SetupComplete.cmd runs firstboot.ps1 (spec 10.2) ---
# Sysprep resets services, code pages, BCD, WinRE, NetBIOS and firewall rules.
$setupComplete = Join-Path $env:SystemRoot 'Setup\Scripts\SetupComplete.cmd'
$firstBoot = Join-Path $env:ProgramData 'sbx-template\firstboot.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $setupComplete) | Out-Null
# cmd mis-parses files with bare LF line ends.
$cmdText = (Get-Content -LiteralPath (Join-Path $SbxFilesDir 'SetupComplete-clone.cmd') -Raw) -replace "`r?`n", "`r`n"
Set-Content -LiteralPath $setupComplete -Value $cmdText -Encoding Ascii -NoNewline
Write-BuildLog "$setupComplete <- files\SetupComplete-clone.cmd"
Copy-BuildFile -Name 'firstboot.ps1' -Destination $firstBoot
# Runs as SYSTEM: only SYSTEM and Administrators may change it.
Invoke-Native -FilePath icacls.exe -ArgumentList @($firstBoot, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '/grant:r', '*S-1-5-32-544:F', '/grant:r', '*S-1-5-32-545:R')

# --- Event logs (last, after everything above logged) ---
# Get-NativeOutput already returns an array (return , $out); @() would nest it.
$logs = Get-NativeOutput -FilePath wevtutil.exe -ArgumentList @('el')
$failed = 0
foreach ($l in $logs) {
    $ErrorActionPreference = 'Continue'
    & wevtutil.exe cl $l 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $failed++ }
    $ErrorActionPreference = 'Stop'
}
Write-BuildLog "event logs cleared: $($logs.Count - $failed) of $($logs.Count)"

# --- TRIM: not fatal until the pinned virtio-win has the vioscsi fix (spec 23) ---
try {
    Optimize-Volume -DriveLetter C -ReTrim
    Write-BuildLog 'C: retrimmed'
} catch {
    Write-BuildLog "WARNING: Optimize-Volume -ReTrim: $($_.Exception.Message)"
}

# --- Self-check ---
$problems = [Collections.Generic.List[string]]::new()
foreach ($s in $SbxDisabledServices) {
    $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
    if ($null -eq $svc) { continue }
    if ($svc.Status -eq 'Running') { $problems.Add("service $s is running") }
    if ($svc.StartType -eq 'Automatic') { $problems.Add("service $s is Automatic") }
}
$sshd = Get-Service -Name sshd
if ($sshd.Status -ne 'Stopped' -or $sshd.StartType -ne 'Manual') { $problems.Add("sshd is $($sshd.Status)/$($sshd.StartType), want Stopped/Manual") }
$keys = @(Get-ChildItem -LiteralPath (Join-Path $env:ProgramData 'ssh'), 'C:\Users' -Recurse -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*authorized_keys*' -or $_.Name -like 'ssh_host_*' })
foreach ($k in $keys) { $problems.Add("$($k.FullName) exists") }
# Answer files with a password element anywhere setup keeps its logs.
foreach ($dir in @((Join-Path $env:SystemRoot 'Panther'), (Join-Path $env:SystemRoot 'System32\Sysprep'))) {
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -Force -File -Include '*.xml' -ErrorAction SilentlyContinue)) {
        if ($f.Name -ieq 'sbx-unattend.xml' -and $f.DirectoryName -ieq (Join-Path $env:SystemRoot 'System32\Sysprep')) { continue }
        if (Select-String -LiteralPath $f.FullName -Pattern '<(Password|AdministratorPassword|AutoLogon)>' -Quiet) {
            $problems.Add("$($f.FullName) has a password element")
        }
    }
}
# Autologon is written by identity apply on the clone, never in the image.
$winlogon = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if ($winlogon.PSObject.Properties['DefaultPassword']) { $problems.Add('Winlogon has DefaultPassword') }
$autoLogon = $winlogon.PSObject.Properties['AutoAdminLogon']
if ($autoLogon -and "$($autoLogon.Value)" -ne '0') { $problems.Add("Winlogon AutoAdminLogon is '$($autoLogon.Value)'") }
# Installers and updates since 00-base add their own rules (Edge and WebView2 add mDNS-In).
$late = @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
foreach ($r in $late) { Write-BuildLog "firewall: disabling late inbound allow rule $($r.Name) ($($r.DisplayName))" }
if ($late.Count -gt 0) { $late | Disable-NetFirewallRule }
$allow = @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
foreach ($r in $allow) { $problems.Add("firewall rule $($r.Name) allows inbound") }
foreach ($fp in @(Get-NetFirewallProfile)) {
    if ("$($fp.Enabled)" -ne 'True' -or "$($fp.DefaultInboundAction)" -ne 'Block') { $problems.Add("firewall profile $($fp.Name): Enabled=$($fp.Enabled), inbound $($fp.DefaultInboundAction)") }
}
$bde = Get-BitLockerStatus
if ($bde.Conversion -ne '' -and ($bde.Conversion -ne 'Fully Decrypted' -or $bde.Protection -ne 'Protection Off')) {
    $problems.Add("BitLocker C: is '$($bde.Conversion)', '$($bde.Protection)'")
}
if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\Sysprep\sbx-unattend.xml'))) { $problems.Add('sbx-unattend.xml is missing') }
foreach ($f in @($setupComplete, $firstBoot)) {
    if (-not (Test-Path -LiteralPath $f)) { $problems.Add("$f is missing") }
}
if ((Test-Path -LiteralPath $setupComplete) -and -not (Select-String -LiteralPath $setupComplete -SimpleMatch 'firstboot.ps1' -Quiet)) {
    $problems.Add("$setupComplete does not run firstboot.ps1")
}
# Informative: sysprep /generalize fails (0x80073cf2) on a package installed for
# a user but not provisioned; setuperr.log then names it.
try {
    $provisioned = @(Get-AppxProvisionedPackage -Online | ForEach-Object { $_.DisplayName })
    # Appx in pwsh 7 may need the Windows PowerShell compatibility session.
    try { $installed = @(Get-AppxPackage -AllUsers) } catch {
        Import-Module Appx -UseWindowsPowerShell -WarningAction SilentlyContinue
        $installed = @(Get-AppxPackage -AllUsers)
    }
    $userOnly = @($installed | Where-Object { "$($_.SignatureKind)" -ne 'System' -and -not $_.IsFramework -and $provisioned -notcontains $_.Name } |
            ForEach-Object { $_.Name } | Sort-Object -Unique)
    if ($userOnly.Count -gt 0) {
        Write-BuildLog "WARNING: Appx installed for a user but not provisioned (sysprep may refuse them): $($userOnly -join ', ')"
    } else {
        Write-BuildLog 'Appx: every non-system package installed for a user is provisioned'
    }
} catch {
    Write-BuildLog "WARNING: Appx check: $($_.Exception.Message)"
}
if (-not (Test-Path -LiteralPath $manifest)) { $problems.Add("$manifest is missing") }
if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-BuildLog "CHECK FAILED: $_" }
    throw "self-check: $($problems.Count) problem(s)"
}
Write-BuildLog 'self-check passed'
Write-BuildLog 'done'
