# Shared helpers of the Windows build steps (spec S9 section 8). Dot-sourced
# by every step:  . (Join-Path $PSScriptRoot '..\lib.ps1')
# Steps run as SYSTEM from a scheduled task through run-step.ps1, which sets
# UMIAK_BUILD_DIR (<UMIAKBUILD drive>:\build). HKCU there is SYSTEM's: per-user
# defaults go to the Default User hive (Invoke-WithDefaultUserHive).
# Loaded by Windows PowerShell 5.1 and pwsh 7: keep this file ASCII.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$UmiakBuildDir = if ($env:UMIAK_BUILD_DIR) { $env:UMIAK_BUILD_DIR } else { $PSScriptRoot }
$UmiakFilesDir = Join-Path $UmiakBuildDir 'files'
$UmiakLogDir = 'C:\umiak-build\logs'
# Downloads and unpacked archives; 90-cleanup empties it, the builder removes C:\umiak-build.
$UmiakWorkDir = 'C:\umiak-build\work'

# Services of spec section 8.1 that end up Disabled. 00-base disables all but
# the update services: the OpenSSH FoD in 10-system comes from Windows Update
# through Delivery Optimization. 90-cleanup disables those and checks the
# whole list. dmwappushservice is not here: sysprep /generalize can hang or
# fail without it, so it stays Manual and the specialize pass of the clone
# disables it (SYSPREP_DEFERRED_SERVICES in apps/template-builder/src/windows/media.ts).
# CDPSvc listens on TCP 5040. Sysprep resets some of these on the clone:
# files\firstboot.ps1 disables the same list again (a test keeps them equal).
$UmiakDisabledServices = @(
    'wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain', 'DiagTrack',
    'MapsBroker', 'lfsvc', 'WerSvc', 'RemoteRegistry',
    'Spooler', 'SSDPSRV', 'FDResPub', 'LanmanServer', 'TermService', 'WinRM',
    'CDPSvc'
)
$UmiakUpdateServices = @('wuauserv', 'UsoSvc', 'DoSvc')

$UmiakPwshExe = 'C:\Program Files\PowerShell\7\pwsh.exe'
$UmiakAgentExe = 'C:\Program Files\umiak-agent\current\umiak-agent.exe'

# Windows 11 .NET Framework defaults to the OS TLS settings; make TLS 1.2 explicit for 5.1.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-BuildLog([string]$Message) {
    Write-Host ('[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $Message)
}

# Runs a console tool, streams its output to the log and fails on an exit
# code outside $SuccessCodes. Arguments must not contain double quotes
# (Windows PowerShell 5.1 passes them through unescaped).
function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$SuccessCodes = @(0),
        # Returns the exit code (one of $SuccessCodes).
        [switch]$PassThru
    )
    Write-BuildLog "> $FilePath $($ArgumentList -join ' ')"
    # A missing command must fail here: with 'Continue' below, $LASTEXITCODE would be stale.
    $null = Get-Command -Name $FilePath -CommandType Application
    # With 'Stop', Windows PowerShell 5.1 turns the first stderr line into a terminating error.
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    $code = $LASTEXITCODE
    if ($SuccessCodes -notcontains $code) { throw "$FilePath $($ArgumentList -join ' '): exit code $code" }
    if ($PassThru) { return $code }
}

# Kills a process and every process it started.
function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
    if ($PSVersionTable.PSVersion.Major -ge 7) {
        try { $Process.Kill($true) } catch { Write-BuildLog "kill of PID $($Process.Id): $($_.Exception.Message)" }
    } else {
        $ErrorActionPreference = 'Continue'
        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $Process.Id /T /F 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    }
    $null = $Process.WaitForExit(10000)
}

# Runs a console tool as a probe (`--version`, `prefix -g`): stdin redirected
# and closed, so a tool that waits for input sees EOF, and killed with its
# process tree when it does not exit within $TimeoutSec. Returns ExitCode,
# Output (stdout lines) and Errors (stderr lines). Arguments with spaces are
# quoted; none may contain double quotes.
function Invoke-Probe {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSec = 120
    )
    $cmdLine = "$FilePath $($ArgumentList -join ' ')"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = (@($ArgumentList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    try {
        $p.StandardInput.Close()
        $out = $p.StandardOutput.ReadToEndAsync()
        $err = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutSec * 1000)) {
            Stop-ProcessTree $p
            throw "${cmdLine}: no exit within $TimeoutSec s (stdin closed); its process tree was killed"
        }
        # A child that outlives the tool keeps the pipes open.
        if (-not [System.Threading.Tasks.Task]::WaitAll(@($out, $err), 30000)) {
            throw "${cmdLine}: exited, but a process it started still holds its output open"
        }
        $p.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $p.ExitCode
            Output = @($out.Result -split '\r?\n' | Where-Object { $_ -ne '' })
            Errors = @($err.Result -split '\r?\n' | Where-Object { $_ -ne '' })
        }
    } finally {
        $p.Dispose()
    }
}

# First line of `<command> <args>` (stdout, else stderr) from the system Path,
# '' when the command is missing. Through Invoke-Probe: a tool that hangs fails
# the step after 120 s.
function Get-InstalledVersion([string]$Command, [string[]]$Arguments) {
    Update-SessionPath
    $c = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $c) { return '' }
    $r = Invoke-Probe -FilePath $c.Source -ArgumentList $Arguments
    return "$(@($r.Output + $r.Errors) | Select-Object -First 1)".Trim()
}

# Same as Invoke-Native, but returns the stdout lines instead of logging them.
function Get-NativeOutput {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$SuccessCodes = @(0)
    )
    $null = Get-Command -Name $FilePath -CommandType Application
    $ErrorActionPreference = 'Continue'
    # stderr goes to the log, so warnings never end up in parsed output.
    $out = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host "stderr: $_" } else { [string]$_ }
        })
    $code = $LASTEXITCODE
    if ($SuccessCodes -notcontains $code) {
        $out | ForEach-Object { Write-Host $_ }
        throw "$FilePath $($ArgumentList -join ' '): exit code $code"
    }
    return , $out
}

# Runs an installer (GUI subsystem, so Start-Process -Wait) and accepts 0 and
# 3010 (success, reboot pending: sysprep reboots anyway). MSI exit 1618 means
# another installation holds the Windows Installer mutex (Windows' own
# servicing): it is retried three times, 30 s apart.
function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$Arguments
    )
    for ($i = 0; ; $i++) {
        Write-BuildLog "> $FilePath $Arguments"
        $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
        if ($p.ExitCode -ne 1618 -or $i -ge 3) { break }
        Write-BuildLog "${FilePath}: exit code 1618 (another installation is in progress); retrying in 30 s"
        Start-Sleep -Seconds 30
    }
    if (@(0, 3010) -notcontains $p.ExitCode) { throw "${FilePath}: exit code $($p.ExitCode)" }
}

function Invoke-Msi {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Properties = @()
    )
    $log = Join-Path $UmiakLogDir ((Split-Path -Leaf $Path) + '.log')
    $msiArgs = "/i `"$Path`" /qn /norestart /l*v `"$log`" $($Properties -join ' ')"
    Invoke-Installer -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -Arguments $msiArgs.Trim()
}

function Get-BuildVersionInfo {
    if (-not (Test-Path variable:script:UmiakVersions)) {
        $path = Join-Path $UmiakBuildDir 'versions.json'
        $script:UmiakVersions = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    return $script:UmiakVersions
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Expected -notmatch '^[0-9A-Fa-f]{64}$') { throw "no valid sha256 pinned for ${Path}: '$Expected'" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
    if ($actual -ne $Expected) {
        Remove-Item -Force -LiteralPath $Path
        throw "sha256 mismatch for ${Path}: got $actual, want $Expected"
    }
}

# Downloads $Url into the work dir (3 tries) and checks it against the pinned
# sha256. A file left by an earlier run is reused when its hash matches.
function Save-VerifiedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    $dir = Join-Path $UmiakWorkDir 'downloads'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $dest = Join-Path $dir ([IO.Path]::GetFileName(([Uri]$Url).AbsolutePath))
    if ((Test-Path -LiteralPath $dest) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $dest).Hash -eq $Sha256) {
        Write-BuildLog "$dest is already downloaded"
        return $dest
    }
    for ($i = 1; ; $i++) {
        try {
            Write-BuildLog "downloading $Url (try $i)"
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $dest
            break
        } catch {
            if ($i -ge 3) { throw }
            Write-BuildLog "download failed: $($_.Exception.Message); retrying in $(10 * $i) s"
            Start-Sleep -Seconds (10 * $i)
        }
    }
    Assert-Sha256 -Path $dest -Expected $Sha256
    return $dest
}

# The verified installer or archive of versions.json tools.<Name>.
function Get-ToolFile {
    param([Parameter(Mandatory = $true)][string]$Name)
    $t = Get-ToolPin $Name
    return Save-VerifiedFile -Url $t.url -Sha256 $t.sha256
}

function Get-ToolPin([string]$Name) {
    $p = (Get-BuildVersionInfo).tools.PSObject.Properties[$Name]
    if ($null -eq $p) { throw "versions.json has no tools.$Name" }
    return $p.Value
}

function Get-ToolVersion([string]$Name) {
    return [string](Get-ToolPin $Name).version
}

# Creates the key when missing (New-Item -Force on an existing key would clear it).
function Set-RegValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Value,
        [ValidateSet('String', 'ExpandString', 'DWord', 'QWord', 'MultiString')][string]$Type = 'DWord'
    )
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -Path $Path -Force | Out-Null }
    New-ItemProperty -LiteralPath $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

function Remove-RegValue([string]$Path, [string]$Name) {
    if ((Test-Path -LiteralPath $Path) -and $null -ne (Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue)) {
        Remove-ItemProperty -LiteralPath $Path -Name $Name
    }
}

function Get-ServiceStart([string]$Name) {
    return (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -Name Start).Start
}

# Start=4. Set-Service is refused for some protected services; the registry
# value is the same setting. A missing service is not an error (editions differ).
function Disable-UmiakService {
    param([Parameter(Mandatory = $true)][string]$Name, [switch]$StopNow)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { Write-BuildLog "service ${Name}: not installed"; return }
    if ($StopNow -and $svc.Status -ne 'Stopped') { Stop-Service -Name $Name -Force }
    try {
        Set-Service -Name $Name -StartupType Disabled
    } catch {
        Write-BuildLog "service ${Name}: Set-Service failed ($($_.Exception.Message)), writing Start=4"
        Set-RegValue -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -Name Start -Value 4
    }
    if ((Get-ServiceStart $Name) -ne 4) { throw "service ${Name}: still not Disabled" }
    Write-BuildLog "service ${Name}: Disabled"
}

function Set-UmiakServiceStartup {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('Automatic', 'Manual')][string]$StartupType
    )
    if ($null -eq (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { throw "service $Name is not installed" }
    Set-Service -Name $Name -StartupType $StartupType
    Write-BuildLog "service ${Name}: $StartupType"
}

# Raw (unexpanded) system Path, so %SystemRoot% entries stay REG_EXPAND_SZ.
function Add-MachinePath([string]$Dir) {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    $raw = [string](Get-Item -LiteralPath $key).GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $parts = @($raw -split ';' | Where-Object { $_ -ne '' })
    if (@($parts | Where-Object { $_.TrimEnd('\') -ieq $Dir.TrimEnd('\') }).Count -eq 0) {
        Set-RegValue -Path $key -Name Path -Value (($parts + $Dir) -join ';') -Type ExpandString
        Write-BuildLog "system Path += $Dir"
    }
    Update-SessionPath
}

function Set-MachineEnv([string]$Name, [string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Machine')
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    Write-BuildLog "system env $Name=$Value"
}

# This process sees what installers wrote to the system Path.
function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
}

function Assert-Command([string]$Name) {
    # Installers write the system Path; this process only sees it after a refresh.
    Update-SessionPath
    $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $c) { throw "$Name is not found in the system Path" }
    return $c.Source
}

function Copy-BuildFile {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Destination)
    $src = Join-Path $UmiakFilesDir $Name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $src -Destination $Destination -Force
    Write-BuildLog "$Destination <- files\$Name"
}

# Unpacks a zip into a fresh dir under the work dir and returns its path.
function Expand-ToWorkDir([string]$Zip, [string]$Name) {
    $dir = Join-Path $UmiakWorkDir $Name
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Expand-Archive -LiteralPath $Zip -DestinationPath $dir
    return $dir
}

# Conversion and protection status of C: from manage-bde ('' when BitLocker is
# not part of the edition), e.g. 'Fully Decrypted' and 'Protection Off'.
function Get-BitLockerStatus {
    $exe = Join-Path $env:SystemRoot 'System32\manage-bde.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return [pscustomobject]@{ Conversion = ''; Protection = '' } }
    $out = Get-NativeOutput -FilePath $exe -ArgumentList @('-status', 'C:') -SuccessCodes @(0, -1)
    $conv = @($out | Where-Object { $_ -match '^\s*Conversion Status:\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1
    $prot = @($out | Where-Object { $_ -match '^\s*Protection Status:\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1
    return [pscustomobject]@{ Conversion = "$conv"; Protection = "$prot" }
}

# Loads C:\Users\Default\NTUSER.DAT (the template of every new profile) and
# runs $Script with the registry root of the hive as its argument.
function Invoke-WithDefaultUserHive([scriptblock]$Script) {
    $hive = 'HKU\UmiakDefaultUser'
    $root = 'Registry::HKEY_USERS\UmiakDefaultUser'
    # Left loaded by an interrupted run.
    if (Test-Path -LiteralPath $root) { Invoke-Native -FilePath reg.exe -ArgumentList @('unload', $hive) }
    Invoke-Native -FilePath reg.exe -ArgumentList @('load', $hive, 'C:\Users\Default\NTUSER.DAT')
    try {
        & $Script $root
    } finally {
        # Registry handles of the provider are released by the finalizers.
        [GC]::Collect()
        [GC]::WaitForPendingFinalizers()
        for ($i = 1; ; $i++) {
            $ErrorActionPreference = 'Continue'
            & reg.exe unload $hive 2>&1 | ForEach-Object { Write-Host ([string]$_) }
            $code = $LASTEXITCODE
            $ErrorActionPreference = 'Stop'
            if ($code -eq 0) { break }
            # Antivirus scans and the registry provider can hold it for a while.
            if ($i -ge 30) { throw "reg unload $hive failed $i times in about 60 s" }
            Start-Sleep -Seconds 2
            [GC]::Collect()
            [GC]::WaitForPendingFinalizers()
        }
    }
}
