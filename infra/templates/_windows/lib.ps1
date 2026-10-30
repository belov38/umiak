# Shared helpers of the Windows build steps (spec S9 section 8). Dot-sourced
# by every step:  . (Join-Path $PSScriptRoot '..\lib.ps1')
# Steps run as SYSTEM from a scheduled task through run-step.ps1, which sets
# SBX_BUILD_DIR (<SBXBUILD drive>:\build). HKCU there is SYSTEM's: per-user
# defaults go to the Default User hive (Invoke-WithDefaultUserHive).
# Loaded by Windows PowerShell 5.1 and pwsh 7: keep this file ASCII.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$SbxBuildDir = if ($env:SBX_BUILD_DIR) { $env:SBX_BUILD_DIR } else { $PSScriptRoot }
$SbxFilesDir = Join-Path $SbxBuildDir 'files'
$SbxLogDir = 'C:\sbx-build\logs'
# Downloads and unpacked archives; 90-cleanup empties it, the builder removes C:\sbx-build.
$SbxWorkDir = 'C:\sbx-build\work'

# Services of spec section 8.1 that end up Disabled. 00-base disables all but
# the update services: the OpenSSH FoD in 10-system comes from Windows Update
# through Delivery Optimization. 90-cleanup disables those and checks the
# whole list.
$SbxDisabledServices = @(
    'wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain', 'DiagTrack',
    'dmwappushservice', 'MapsBroker', 'lfsvc', 'WerSvc', 'RemoteRegistry',
    'Spooler', 'SSDPSRV', 'FDResPub', 'LanmanServer', 'TermService', 'WinRM'
)
$SbxUpdateServices = @('wuauserv', 'UsoSvc', 'DoSvc')

$SbxPwshExe = 'C:\Program Files\PowerShell\7\pwsh.exe'
$SbxAgentExe = 'C:\Program Files\sbx-agent\current\sbx-agent.exe'

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
        [int[]]$SuccessCodes = @(0)
    )
    Write-BuildLog "> $FilePath $($ArgumentList -join ' ')"
    # A missing command must fail here: with 'Continue' below, $LASTEXITCODE would be stale.
    $null = Get-Command -Name $FilePath -CommandType Application
    # With 'Stop', Windows PowerShell 5.1 turns the first stderr line into a terminating error.
    $ErrorActionPreference = 'Continue'
    & $FilePath @ArgumentList 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    $code = $LASTEXITCODE
    if ($SuccessCodes -notcontains $code) { throw "$FilePath $($ArgumentList -join ' '): exit code $code" }
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
# 3010 (success, reboot pending: sysprep reboots anyway).
function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string]$Arguments
    )
    Write-BuildLog "> $FilePath $Arguments"
    $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru
    if (@(0, 3010) -notcontains $p.ExitCode) { throw "${FilePath}: exit code $($p.ExitCode)" }
}

function Invoke-Msi {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Properties = @()
    )
    $log = Join-Path $SbxLogDir ((Split-Path -Leaf $Path) + '.log')
    $msiArgs = "/i `"$Path`" /qn /norestart /l*v `"$log`" $($Properties -join ' ')"
    Invoke-Installer -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -Arguments $msiArgs.Trim()
}

function Get-BuildVersionInfo {
    if (-not (Test-Path variable:script:SbxVersions)) {
        $path = Join-Path $SbxBuildDir 'versions.json'
        $script:SbxVersions = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    return $script:SbxVersions
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
    $dir = Join-Path $SbxWorkDir 'downloads'
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
function Disable-SbxService {
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

function Set-SbxServiceStartup {
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
    $c = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $c) { throw "$Name is not found in the system Path" }
    return $c.Source
}

function Copy-BuildFile {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Destination)
    $src = Join-Path $SbxFilesDir $Name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $src -Destination $Destination -Force
    Write-BuildLog "$Destination <- files\$Name"
}

# Unpacks a zip into a fresh dir under the work dir and returns its path.
function Expand-ToWorkDir([string]$Zip, [string]$Name) {
    $dir = Join-Path $SbxWorkDir $Name
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
    $hive = 'HKU\SbxDefaultUser'
    $root = 'Registry::HKEY_USERS\SbxDefaultUser'
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
            if ($i -ge 5) { throw "reg unload $hive failed" }
            Start-Sleep -Seconds 2
            [GC]::Collect()
        }
    }
}
