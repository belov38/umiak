# Clone first boot (spec S9 section 10.2). SetupComplete.cmd of every clone
# runs this once as SYSTEM at the end of Windows Setup, before the first logon
# and before the agent's rename reboot (ruling R16). It restores what sysprep
# generalize, specialize and OOBE reset: services, code pages (they apply at
# the next boot, the rename reboot), BCD, WinRE, NetBIOS and the firewall
# policy. 90-cleanup installs it to C:\ProgramData\sbx-template\firstboot.ps1.
# Self-contained (lib.ps1 is not on the clone), Windows PowerShell 5.1, ASCII.
# Never fails Setup: every failure is logged and the script exits 0. The log
# holds no secrets.
param([string]$LogPath = 'C:\ProgramData\sbx-template\firstboot.log')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# $SbxDisabledServices and $SbxUpdateServices of _windows\lib.ps1 plus
# dmwappushservice (Manual through sysprep, see SYSPREP_DEFERRED_SERVICES) and
# CDPSvc. A test keeps this list equal to lib.ps1's.
$Services = @(
    'wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain', 'DiagTrack',
    'MapsBroker', 'lfsvc', 'WerSvc', 'RemoteRegistry',
    'Spooler', 'SSDPSRV', 'FDResPub', 'LanmanServer', 'TermService', 'WinRM',
    'CDPSvc', 'dmwappushservice'
)
$ServicesKey = 'HKLM:\SYSTEM\CurrentControlSet\Services'

function Write-Log([string]$Message) {
    try {
        $dir = Split-Path -Parent $LogPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $line = '[{0}] {1}' -f (Get-Date).ToUniversalTime().ToString('HH:mm:ss'), $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding Ascii
    } catch {
        # Nothing to report to: Setup shows no output of this script.
    }
}

# Runs one part; an error is logged and the next part runs.
function Invoke-Part([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
    } catch {
        Write-Log "ERROR ${Name}: $($_.Exception.Message)"
    }
}

# Runs a console tool and logs its exit code and first output line.
function Invoke-Tool([string]$FilePath, [string[]]$ArgumentList) {
    $ErrorActionPreference = 'Continue'
    $out = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    $code = $LASTEXITCODE
    $first = if ($out.Count -gt 0) { $out[0] } else { '' }
    if ($code -ne 0) { Write-Log "ERROR $FilePath $($ArgumentList -join ' '): exit $code $first" }
    else { Write-Log "$FilePath $($ArgumentList -join ' '): exit 0" }
}

Write-Log 'start'

Invoke-Part 'services' {
    foreach ($s in $Services) {
        Invoke-Part "service $s" {
            $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
            if ($null -eq $svc) { Write-Log "service ${s}: not installed"; return }
            try {
                Set-Service -Name $s -StartupType Disabled
            } catch {
                # Set-Service is refused for some protected services; Start=4 is the same setting.
                Set-ItemProperty -LiteralPath "$ServicesKey\$s" -Name Start -Value 4 -Type DWord
            }
            Stop-Service -Name $s -Force -ErrorAction SilentlyContinue
            $start = (Get-ItemProperty -LiteralPath "$ServicesKey\$s" -Name Start).Start
            $status = (Get-Service -Name $s).Status
            if ($start -ne 4) { Write-Log "ERROR service ${s}: Start=$start, $status" }
            else { Write-Log "service ${s}: Start=4, $status" }
        }
    }
}

# UTF-8 as the system code page; Windows reads it at the next boot.
Invoke-Part 'code pages' {
    $cp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage'
    foreach ($n in @('ACP', 'OEMCP', 'MACCP')) {
        Set-ItemProperty -LiteralPath $cp -Name $n -Value '65001' -Type String
    }
    Write-Log 'code pages: ACP, OEMCP, MACCP = 65001'
}

# A hard stop must never lead to Automatic Repair.
Invoke-Part 'winre' { Invoke-Tool 'reagentc.exe' @('/disable') }
Invoke-Part 'bcd recoveryenabled' { Invoke-Tool 'bcdedit.exe' @('/set', '{current}', 'recoveryenabled', 'no') }
Invoke-Part 'bcd bootstatuspolicy' { Invoke-Tool 'bcdedit.exe' @('/set', '{current}', 'bootstatuspolicy', 'ignoreallfailures') }

# NetBIOS over TCP/IP off on every interface (setup adds the NIC anew).
Invoke-Part 'netbios' {
    foreach ($k in @(Get-ChildItem -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\NetBT\Parameters\Interfaces')) {
        Set-ItemProperty -LiteralPath $k.PSPath -Name NetbiosOptions -Value 2 -Type DWord
    }
    foreach ($a in @(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true')) {
        $r = Invoke-CimMethod -InputObject $a -MethodName SetTcpipNetbios -Arguments @{ TcpipNetbiosOptions = [uint32]2 }
        Write-Log "netbios off on $($a.Description): $($r.ReturnValue)"
    }
}

# Setup and Appx registration enable inbound allow rules again; the policy
# makes Windows ignore every local rule.
Invoke-Part 'firewall' {
    foreach ($p in @('DomainProfile', 'PrivateProfile', 'PublicProfile')) {
        $k = "HKLM:\SOFTWARE\Policies\Microsoft\WindowsFirewall\$p"
        if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }
        Set-ItemProperty -LiteralPath $k -Name AllowLocalPolicyMerge -Value 0 -Type DWord
    }
    Write-Log 'firewall: local rules ignored (policy AllowLocalPolicyMerge=0)'
}

Write-Log 'done'
exit 0
