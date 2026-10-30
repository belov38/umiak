#requires -Version 7
# 90-cleanup (spec S9 section 8.8): update services off, component store,
# downloads and caches, answer files with the build password, event logs,
# TRIM, then a self-check. The builder wrote C:\ProgramData\sbx-template\build.json
# right before this step (it stays) and removes C:\sbx-build after reading
# this log; it runs `sbx-agent seal` and sysprep itself.
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

# --- Windows Update services: the FoD is installed ---
foreach ($s in $SbxUpdateServices) { Disable-SbxService -Name $s -StopNow }

# --- Component store ---
Invoke-Native -FilePath (Join-Path $env:SystemRoot 'System32\Dism.exe') -ArgumentList @('/Online', '/Cleanup-Image', '/StartComponentCleanup', '/ResetBase') -SuccessCodes @(0, 3010)

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
        (Join-Path $sysProfile 'AppData\Local\Temp\*'))) {
    Remove-Leftover $p
}

# --- Answer files: the build password is in the cached autounattend ---
foreach ($p in @(
        (Join-Path $env:SystemRoot 'Panther\unattend*.xml'),
        (Join-Path $env:SystemRoot 'Panther\autounattend*.xml'),
        (Join-Path $env:SystemRoot 'Panther\Unattend'),
        (Join-Path $env:SystemRoot 'System32\Sysprep\unattend*.xml'),
        (Join-Path $env:SystemRoot 'System32\Sysprep\Panther\unattend*.xml'),
        # It would run again at the end of every clone's setup.
        (Join-Path $env:SystemRoot 'Setup\Scripts\SetupComplete.cmd'))) {
    Remove-Leftover $p
}

# --- Event logs (last, after everything above logged) ---
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
$winlogon = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
if ($winlogon.PSObject.Properties['DefaultPassword']) { $problems.Add('Winlogon has DefaultPassword') }
if (-not (Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32\Sysprep\sbx-unattend.xml'))) { $problems.Add('sbx-unattend.xml is missing') }
if (-not (Test-Path -LiteralPath $manifest)) { $problems.Add("$manifest is missing") }
if ($problems.Count -gt 0) {
    $problems | ForEach-Object { Write-BuildLog "CHECK FAILED: $_" }
    throw "self-check: $($problems.Count) problem(s)"
}
Write-BuildLog 'self-check passed'
Write-BuildLog 'done'
