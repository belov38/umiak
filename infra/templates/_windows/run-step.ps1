# Build step wrapper (spec S9 section 7 p.5), started by a SYSTEM scheduled task:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <SBXBUILD>:\build\run-step.ps1 -Step <n>
# Runs build\steps\<n>.ps1 of the build ISO (volume label SBXBUILD) in pwsh when
# its first line is "#requires -Version 7", else in Windows PowerShell 5.1.
# All output goes to C:\sbx-build\logs\<n>.log (UTF-8 without BOM, truncated at
# start); the exit code goes to <n>.exit, written last through a rename from
# <n>.exit.tmp, so the builder never reads a partial value.
# Steps get SBX_BUILD_DIR = <drive>:\build of the build ISO.
# A log write never fails the step: another handle may hold the log for a while.
# Runs in Windows PowerShell 5.1: keep this file ASCII and 5.1-compatible.
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*$')]
    [string]$Step
)

$ErrorActionPreference = 'Stop'
$logDir = 'C:\sbx-build\logs'
$log = Join-Path $logDir "$Step.log"
$exitFile = Join-Path $logDir "$Step.exit"
$exitTmp = "$exitFile.tmp"
$utf8 = New-Object System.Text.UTF8Encoding($false)

# Retries of one log write while another handle locks the log out.
$logRetries = 40
$logRetryMs = 250
# Lines not written yet; they go out with the next write that succeeds.
$pending = New-Object System.Text.StringBuilder
# After a write gave up, the next lines try once each, so a log that stays locked does not slow
# the step down; the first write that gets through ends that.
$logStuck = $false

function Open-Log([System.IO.FileMode]$Mode) {
    [System.IO.File]::Open($log, $Mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]'ReadWrite, Delete')
}

# Never throws.
function Write-Log([string]$Line, [switch]$Final) {
    [void]$script:pending.Append($Line).Append("`n")
    $tries = $logRetries
    if ($script:logStuck -and -not $Final) { $tries = 1 }
    for ($i = 0; $i -lt $tries; $i++) {
        try {
            $bytes = $utf8.GetBytes($script:pending.ToString())
            $f = Open-Log ([System.IO.FileMode]::Append)
            try { $f.Write($bytes, 0, $bytes.Length) } finally { $f.Dispose() }
            [void]$script:pending.Clear()
            $script:logStuck = $false
            return
        } catch {
            $e = $_.Exception
            if ($e.InnerException) { $e = $e.InnerException }
            # Only a sharing or lock violation goes away by waiting.
            if (-not ($e -is [System.IO.IOException]) -or
                $e -is [System.IO.FileNotFoundException] -or
                $e -is [System.IO.DirectoryNotFoundException]) { break }
            if ($i + 1 -lt $tries) { Start-Sleep -Milliseconds $logRetryMs }
        }
    }
    $script:logStuck = $true
}

$code = 1
try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $exitFile, $exitTmp
    # Truncate; a log that cannot be truncated is appended to.
    try { (Open-Log ([System.IO.FileMode]::Create)).Dispose() } catch { }

    # A missing Storage module throws even with SilentlyContinue.
    $vol = $null
    try {
        $vol = Get-Volume -FileSystemLabel SBXBUILD -ErrorAction SilentlyContinue |
            Where-Object { $_.DriveLetter } | Select-Object -First 1
    } catch { }
    if ($vol) {
        $root = "$($vol.DriveLetter):\"
    } else {
        # Storage cmdlets unavailable: this script itself lives in <drive>:\build.
        $root = Split-Path -Parent $PSScriptRoot
        Write-Log "run-step: no volume labelled SBXBUILD, using $root"
    }
    $buildDir = Join-Path $root 'build'
    $script = Join-Path $buildDir "steps\$Step.ps1"
    if (-not (Test-Path -LiteralPath $script)) { throw "step file not found: $script" }

    $first = Get-Content -LiteralPath $script -TotalCount 1
    if ("$first" -match '^\s*#requires\s+-Version\s+7(\.\d+)*\s*$') {
        $exe = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
        if (-not (Test-Path -LiteralPath $exe)) { throw "step ${Step} needs PowerShell 7: $exe not found" }
    } else {
        $exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    }
    Write-Log "run-step: ${Step}: $exe -File $script"

    # The child inherits the console code page, so it writes UTF-8, and the
    # pipeline below decodes it as UTF-8.
    try { [Console]::OutputEncoding = $utf8 } catch { Write-Log "run-step: console encoding: $($_.Exception.Message)" }
    $env:SBX_BUILD_DIR = $buildDir
    # Plain error records in the log: pwsh 7 colours them with ANSI sequences otherwise.
    $env:NO_COLOR = '1'

    # stderr lines arrive as ErrorRecords; with 'Stop' the first one would end this wrapper.
    $ErrorActionPreference = 'Continue'
    & $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script 2>&1 | ForEach-Object {
        Write-Log ([string]$_)
    }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($null -eq $code) { $code = 1 }
} catch {
    $code = 1
    Write-Log "run-step: $($_.Exception.Message)"
}

Write-Log "run-step: ${Step}: exit code $code" -Final
Set-Content -LiteralPath $exitTmp -Value ([string]$code) -NoNewline -Encoding Ascii
Move-Item -LiteralPath $exitTmp -Destination $exitFile -Force
exit $code
