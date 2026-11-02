#requires -Version 7
# Guest checks of a Windows template build (spec S9 section 15.1). umiak-tpl writes this file to
# C:\Windows\Temp\umiak-verify.ps1 on a clone and runs it as SYSTEM through QGA:
#   pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <this> -MachineId <uuid> ...
# Output, one line each:
#   CHECK <id> <PASS|FAIL|INFO> <evidence>
#   TOOLS <json>    {"<tool>": {"direct": ..., "login": ...}}: first line of the version output as
#                   user through `umiak-agent exec` (argv and the pwsh shell path), or "error: rc=<n> ..."
#   LICENSE <json>  {status, description, graceMinutes, evaluationEnd, editionId}
#   FACTS <json>    (-Check facts) {computerName, machineGuid, lsaHash, hostKeys, bootsSince}
# -Check <group>[,<group>...] runs only those groups ('-' and '_' are the same). By default:
# os identity first_boot unattend listeners firewall sshd ssh_login agent users autologon services tools
# network trim license leftovers; on demand: vss_events lsa_hash facts.
# Secret values are never printed: the LSA secret of user only as a salted sha256.
param(
    [string]$MachineId = '',
    [string]$ExpectSubnet = '10.88.0.0/24',
    [string]$EditionId = '',
    [string]$Build = '',
    # Comma-separated tool names of the manifest.
    [string]$Tools = '',
    # Host clock when umiak-tpl started this script (time_sync).
    [long]$HostUnixMs = 0,
    # Hex salt of lsa_hash and FACTS.lsaHash.
    [string]$Salt = '',
    # ISO 8601: FACTS.bootsSince counts boots (event 6005) after it.
    [string]$Since = '',
    [string]$Check = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$StartedUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$AgentExe = 'C:\Program Files\umiak-agent\current\umiak-agent.exe'
$PwshExe = 'C:\Program Files\PowerShell\7\pwsh.exe'
$OpenSshDir = Join-Path $env:SystemRoot 'System32\OpenSSH'
$SshDataDir = Join-Path $env:ProgramData 'ssh'
$BuildJson = Join-Path $env:ProgramData 'umiak-template\build.json'
$NpmPrefix = Join-Path $env:ProgramData 'npm'
$UserName = 'user'
# Boots of a clone's first start without the agent: specialize, then OOBE and the logon.
# The agent adds one rename reboot after setup (ruling R16).
$SetupBoots = 2
# Spec 8.1: $UmiakDisabledServices of _windows/lib.ps1 plus dmwappushservice,
# which the specialize pass of umiak-unattend.xml disables on the clone.
$DisabledServices = @(
    'wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain', 'DiagTrack',
    'dmwappushservice', 'MapsBroker', 'lfsvc', 'WerSvc', 'RemoteRegistry',
    'Spooler', 'SSDPSRV', 'FDResPub', 'LanmanServer', 'TermService', 'WinRM',
    'CDPSvc'
)
$FirstBootLog = Join-Path $env:ProgramData 'umiak-template\firstboot.log'
$FirewallPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsFirewall'
$DefenderServices = @('WinDefend', 'WdNisSvc', 'Sense', 'WdBoot', 'WdFilter', 'WdNisDrv')
$ServicesKey = 'HKLM:\SYSTEM\CurrentControlSet\Services'

$LsaSource = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class UmiakLsa
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LsaUnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LsaObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll")]
    private static extern uint LsaOpenPolicy(IntPtr systemName, ref LsaObjectAttributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")]
    private static extern uint LsaRetrievePrivateData(IntPtr policy, ref LsaUnicodeString keyName, out IntPtr privateData);
    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr handle);
    [DllImport("advapi32.dll")]
    private static extern uint LsaFreeMemory(IntPtr buffer);
    [DllImport("advapi32.dll")]
    private static extern int LsaNtStatusToWinError(uint status);

    private const uint PolicyGetPrivateInformation = 0x4;
    private const uint StatusObjectNameNotFound = 0xC0000034;

    // The secret's bytes, null when it does not exist. The caller clears the array.
    public static byte[] Retrieve(string name)
    {
        var attributes = new LsaObjectAttributes();
        attributes.Length = Marshal.SizeOf(typeof(LsaObjectAttributes));
        IntPtr policy;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, PolicyGetPrivateInformation, out policy);
        if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
        IntPtr nameBuffer = Marshal.StringToHGlobalUni(name);
        try
        {
            var key = new LsaUnicodeString
            {
                Length = (ushort)(name.Length * 2),
                MaximumLength = (ushort)(name.Length * 2 + 2),
                Buffer = nameBuffer
            };
            IntPtr data;
            status = LsaRetrievePrivateData(policy, ref key, out data);
            if (status == StatusObjectNameNotFound) return null;
            if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
            try
            {
                var secret = (LsaUnicodeString)Marshal.PtrToStructure(data, typeof(LsaUnicodeString));
                var bytes = new byte[secret.Length];
                if (secret.Length > 0) Marshal.Copy(secret.Buffer, bytes, 0, secret.Length);
                return bytes;
            }
            finally
            {
                LsaFreeMemory(data);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(nameBuffer);
            LsaClose(policy);
        }
    }
}
'@

# --- helpers ---

# CHECK line; $Status is a bool (PASS/FAIL) or 'INFO'.
function Report([string]$Id, $Status, [string]$Evidence = '') {
    $st = if ($Status -is [bool]) { if ($Status) { 'PASS' } else { 'FAIL' } } else { [string]$Status }
    $ev = ($Evidence -replace '\s+', ' ').Trim()
    if ($ev.Length -gt 600) { $ev = $ev.Substring(0, 600) }
    [Console]::Out.WriteLine("CHECK $Id $st $ev")
}

# Runs a native command: exit code and output lines (stderr merged).
function Invoke-Capture([string]$FilePath, [string[]]$ArgumentList = @()) {
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } catch {
        $out = @("$($_.Exception.Message)")
        $code = -1
    }
    return [pscustomobject]@{ Code = $code; Lines = $out; Text = ($out -join "`n") }
}

# First output line of a version command, or "error: rc=<n> <first line>".
function Get-FirstLine($Result) {
    $first = @($Result.Lines) | Select-Object -First 1
    if ($Result.Code -ne 0) { return "error: rc=$($Result.Code) $first".Trim() }
    if ($null -eq $first) { return '' }
    return "$first".Trim()
}

function Get-RegValue([string]$Path, [string]$Name) {
    $p = Get-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return $p.$Name
}

# Lower-case hex sha256 of the salt bytes followed by the secret bytes.
function Get-SaltedHash([string]$SaltHex, [byte[]]$Secret) {
    # Not `$x = if (...) { [byte[]]::new(0) }`: the pipeline unrolls an empty array to $null.
    $saltBytes = [byte[]]::new(0)
    if ($SaltHex) { $saltBytes = [Convert]::FromHexString($SaltHex) }
    if ($null -eq $Secret) { $Secret = [byte[]]::new(0) }
    $data = [byte[]]::new($saltBytes.Length + $Secret.Length)
    try {
        [Array]::Copy($saltBytes, 0, $data, 0, $saltBytes.Length)
        [Array]::Copy($Secret, 0, $data, $saltBytes.Length, $Secret.Length)
        return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($data)).ToLowerInvariant()
    } finally {
        [Array]::Clear($data)
    }
}

# Lock state of a session: 'locked', 'unlocked' or 'unknown' (WTSSessionInfoEx SessionFlags).
function Get-SessionLockState([int]$SessionId) {
    if (-not ('UmiakWts' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UmiakWts {
    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSQuerySessionInformation(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")]
    static extern void WTSFreeMemory(IntPtr memory);
    // WTSINFOEXW: Level, then WTSINFOEX_LEVEL1_W { SessionId, SessionState, SessionFlags, ... }.
    // SessionFlags: 0 WTS_SESSIONSTATE_LOCK, 1 WTS_SESSIONSTATE_UNLOCK, -1 unknown.
    public static int Flags(int sessionId) {
        IntPtr buf; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, 25, out buf, out bytes)) return -2;
        try { return Marshal.ReadInt32(buf, 0) == 1 ? Marshal.ReadInt32(buf, 12) : -2; }
        finally { WTSFreeMemory(buf); }
    }
}
'@
    }
    $flags = try { [UmiakWts]::Flags($SessionId) } catch { -2 }
    switch ($flags) {
        0 { return 'locked' }
        1 { return 'unlocked' }
        default { return 'unknown' }
    }
}

# Salted sha256 and length of an LSA secret, $null when it does not exist.
function Get-LsaSecretHash([string]$Name, [string]$SaltHex) {
    if (-not ('UmiakLsa' -as [type])) { Add-Type -TypeDefinition $LsaSource }
    $secret = [UmiakLsa]::Retrieve($Name)
    if ($null -eq $secret) { return $null }
    try {
        return [pscustomobject]@{ Length = $secret.Length; Hash = (Get-SaltedHash $SaltHex $secret) }
    } finally {
        [Array]::Clear($secret)
    }
}

function Test-InCidr([string]$Ip, [string]$Cidr) {
    $net, $len = $Cidr.Split('/')
    $toInt = {
        param([string]$a)
        $b = [Net.IPAddress]::Parse($a).GetAddressBytes()
        [Array]::Reverse($b)
        [BitConverter]::ToUInt32($b, 0)
    }
    # Hex literals are signed in PowerShell (0xFFFFFFFF is -1): the mask is built from longs.
    $mask = [uint32]((1L -shl 32) - (1L -shl (32 - [int]$len)))
    return ((& $toInt $Ip) -band $mask) -eq ((& $toInt $net) -band $mask)
}

# --- checks (spec 15.1 item in brackets) ---

# [1] Edition and build of the manifest.
function Test-Os {
    $cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $ed = [string]$cv.EditionID
    $b = [string]$cv.CurrentBuild
    $ok = $EditionId -ne '' -and $ed -eq $EditionId -and $Build -ne '' -and $b -eq $Build
    Report os $ok "EditionID $ed (want $EditionId), build $b.$($cv.UBR) (want $Build), $($cv.ProductName) $($cv.DisplayVersion)"
}

# [2] Name UMI<12 hex> and MachineGuid of the test machine id.
function Test-Identity {
    $hex = ($MachineId -replace '-', '').ToUpperInvariant()
    if ($hex -notmatch '^[0-9A-F]{32}$') {
        Report computer_name $false "invalid -MachineId '$MachineId'"
        Report machine_guid $false "invalid -MachineId '$MachineId'"
        return
    }
    $want = 'UMI' + $hex.Substring(20)
    $active = [string](Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' 'ComputerName')
    $dns = [string](Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters' 'Hostname')
    Report computer_name ($active -ceq $want -and $dns -eq $want) "active $active, hostname $dns, want $want"
    $guid = [string](Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Cryptography' 'MachineGuid')
    Report machine_guid ($guid.ToLowerInvariant() -eq $MachineId.ToLowerInvariant()) "MachineGuid $guid, want $MachineId"
}

# File name of the process of a planned restart (event 1074, first value:
# '<path> (<computer name>)').
function Get-RestartProcessName([string]$Value) {
    return (($Value -replace '\s*\([^()]*\)\s*$', '') -split '\\')[-1]
}

# Setup's boots plus at most one planned restart by umiak-agent.exe: the rename
# after setup overwrote the specialize name (ruling R16). Ok and Evidence.
function Get-FirstBootVerdict([int]$Boots, [string[]]$RestartBy) {
    $by = @($RestartBy | Where-Object { $_ })
    $agent = @($by | Where-Object { $_ -ieq 'umiak-agent.exe' }).Count
    $limit = $SetupBoots + [math]::Min($agent, 1)
    $ok = $Boots -ge 1 -and $agent -le 1 -and $Boots -le $limit
    $names = if ($by.Count) { ($by | Group-Object | ForEach-Object { "$($_.Name) x$($_.Count)" }) -join ', ' } else { 'none' }
    return [pscustomobject]@{
        Ok = $ok
        Evidence = "$Boots boots since the seal (event 6005), allowed $limit (setup $SetupBoots + $([math]::Min($agent, 1)) rename by umiak-agent.exe, at most one); planned restarts (1074) by: $names"
    }
}

# firstboot.ps1 (SetupComplete.cmd of the clone) ran to its end.
function Test-FirstBootLog([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        Report firstboot_log $false "$Path missing"
        return
    }
    $lines = @(Get-Content -LiteralPath $Path | Where-Object { "$_".Trim() })
    $last = if ($lines.Count -gt 0) { "$($lines[-1])".Trim() } else { '' }
    $errors = @($lines | Where-Object { $_ -match '\] ERROR ' })
    Report firstboot_log ($last -match '\]\s*done$') "$Path $($lines.Count) lines, last '$last'; ERROR lines: $($errors.Count)$(if ($errors.Count) { ' (' + ($errors -join '; ') + ')' })"
}

# [2] Boots of the first start (logs were cleared before sysprep), firstboot.ps1.
function Test-FirstBoot {
    $starts = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6005 } -ErrorAction SilentlyContinue)
    $by = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074 } -ErrorAction SilentlyContinue |
            ForEach-Object { Get-RestartProcessName ([string]$_.Properties[0].Value) })
    $v = Get-FirstBootVerdict $starts.Count ([string[]]$by)
    Report first_boot_reboots $v.Ok $v.Evidence
    Test-FirstBootLog $FirstBootLog
}

# [2] umiak-unattend.xml removed, no password values left in the answer file copies.
function Test-Unattend {
    $f = Join-Path $env:SystemRoot 'System32\Sysprep\umiak-unattend.xml'
    $exists = Test-Path -LiteralPath $f
    Report umiak_unattend_gone (-not $exists) "$f $(if ($exists) { 'exists' } else { 'removed' })"
    $bad = [Collections.Generic.List[string]]::new()
    foreach ($dir in @((Join-Path $env:SystemRoot 'Panther'), (Join-Path $env:SystemRoot 'System32\Sysprep'))) {
        foreach ($x in @(Get-ChildItem -LiteralPath $dir -Recurse -Force -File -Filter '*.xml' -ErrorAction SilentlyContinue)) {
            $text = Get-Content -Raw -LiteralPath $x.FullName -ErrorAction SilentlyContinue
            if ($null -eq $text) { continue }
            foreach ($mm in [regex]::Matches($text, '(?s)<(Password|AdministratorPassword)>.*?<Value>([^<]*)</Value>')) {
                if ($mm.Groups[2].Value.Trim() -notin @('', '*SENSITIVE*DATA*DELETED*')) {
                    $bad.Add($x.FullName)
                    break
                }
            }
        }
    }
    Report panther_clean ($bad.Count -eq 0) $(if ($bad.Count) { "password values in: $($bad -join ', ')" } else { 'no password values in the Panther and Sysprep answer files' })
}

# [3] TCP listeners of the allow-list only; no NetBIOS, SSDP, WS-Discovery, mDNS, LLMNR.
function Test-Listeners {
    $names = @{}
    foreach ($p in Get-Process) { $names[[int]$p.Id] = $p.ProcessName }
    $rpc = @('lsass', 'wininit', 'services', 'svchost', 'spoolsv', 'System')
    $ok = [Collections.Generic.List[string]]::new()
    $bad = [Collections.Generic.List[string]]::new()
    $sshd = @{}
    foreach ($c in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)) {
        $port = [int]$c.LocalPort
        $addr = [string]$c.LocalAddress
        $name = [string]$names[[int]$c.OwningProcess]
        $item = "${addr}:${port}(${name})"
        $allowed = ($port -eq 22 -and $addr -in @('127.0.0.1', '::1') -and $name -eq 'sshd') -or
            ($port -eq 135 -and $name -eq 'svchost') -or
            ($port -ge 49664 -and $port -le 49670 -and $name -in $rpc)
        if ($allowed) { $ok.Add($item) } else { $bad.Add($item) }
        if ($port -eq 22 -and $name -eq 'sshd') { $sshd[$addr] = $true }
    }
    $both = $sshd.ContainsKey('127.0.0.1') -and $sshd.ContainsKey('::1')
    Report listen_tcp ($bad.Count -eq 0 -and $both) "unexpected: $(if ($bad.Count) { $bad -join ' ' } else { 'none' }); sshd on 127.0.0.1 and ::1: $both; allowed: $(($ok | Sort-Object -Unique) -join ' ')"
    $udp = [Collections.Generic.List[string]]::new()
    foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        $port = [int]$u.LocalPort
        if ($port -in @(137, 138, 1900, 3702, 5353, 5355)) { $udp.Add("$($u.LocalAddress):${port}($($names[[int]$u.OwningProcess]))") }
    }
    Report listen_udp ($udp.Count -eq 0) "NetBIOS, SSDP, WS-Discovery, mDNS, LLMNR endpoints: $(if ($udp.Count) { $udp -join ' ' } else { 'none' })"
}

# [4] Firewall on in every profile, inbound blocked, no effective allow rule, no listen notifications.
function Test-Firewall {
    $desc = [Collections.Generic.List[string]]::new()
    $bad = 0
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
    foreach ($p in $profiles) {
        $desc.Add("$($p.Name): enabled $($p.Enabled), inbound $($p.DefaultInboundAction), notify $($p.NotifyOnListen)")
        if ("$($p.Enabled)" -ne 'True' -or "$($p.DefaultInboundAction)" -ne 'Block' -or "$($p.NotifyOnListen)" -ne 'False') { $bad++ }
    }
    Report firewall_profiles ($desc.Count -eq 3 -and $bad -eq 0) ($desc -join '; ')
    # 00-base and firstboot.ps1 set AllowLocalPolicyMerge=0 (Windows ignores the local rules Setup
    # and Appx enable again) and DoNotAllowExceptions=1 ("shields up": inbound allow rules of any
    # store, also the AppX capability rules of the first logon, are not applied).
    $names = @('DomainProfile', 'PrivateProfile', 'PublicProfile')
    $merge = @(foreach ($p in $names) { "$p=$(Get-RegValue "$FirewallPolicy\$p" 'AllowLocalPolicyMerge')" })
    $except = @(foreach ($p in $names) { "$p=$(Get-RegValue "$FirewallPolicy\$p" 'DoNotAllowExceptions')" })
    $policy = @($merge | Where-Object { $_ -match '=0$' }).Count -eq 3
    $shieldsUp = $profiles.Count -eq 3 -and @($profiles | Where-Object { "$($_.AllowInboundRules)" -ne 'False' }).Count -eq 0
    $inbound = ($profiles | ForEach-Object { "$($_.Name)=$($_.AllowInboundRules)" }) -join ', '
    if ($policy) {
        $allow = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
        $what = 'effective (ActiveStore)'
    } else {
        $allow = @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
        $what = 'local'
    }
    $list = ($allow | ForEach-Object { $_.Name }) -join ', '
    $rules = if ($allow.Count -eq 0) { "no $what enabled inbound allow rule" }
    elseif ($shieldsUp) { "$($allow.Count) $what inbound allow rules ineffective: $list" }
    else { "$what inbound allow rules: $list" }
    Report firewall_rules ($shieldsUp -or $allow.Count -eq 0) "ActiveStore AllowInboundRules: $inbound ($(if ($shieldsUp) { 'AllowInboundRules False everywhere: allow rules not applied' } else { 'allow rules applied' })); policy DoNotAllowExceptions: $($except -join ', '); AllowLocalPolicyMerge: $($merge -join ', ') (local rules $(if ($policy) { 'ignored' } else { 'merged' })); $rules"
}

# [5] sshd: effective config, running (the agent started it), host keys of this clone, shell.
function Test-Sshd {
    $t = Invoke-Capture (Join-Path $OpenSshDir 'sshd.exe') @('-T')
    $lines = @($t.Lines | ForEach-Object { $_.Trim().ToLowerInvariant() })
    $want = @('passwordauthentication no', 'kbdinteractiveauthentication no', 'pubkeyauthentication yes', 'listenaddress 127.0.0.1:22', 'listenaddress [::1]:22')
    $missing = @($want | Where-Object { $_ -notin $lines })
    $ca = @($lines | Where-Object { $_ -like 'trustedusercakeys *umiak_user_ca.pub' })
    if ($ca.Count -eq 0) { $missing += 'trustedusercakeys .../umiak_user_ca.pub' }
    $ev = if ($t.Code -ne 0) { "sshd -T exit $($t.Code): $(@($t.Lines | Select-Object -Last 3) -join ' | ')" } elseif ($missing.Count) { "missing: $($missing -join '; ')" } else { ($want + $ca) -join '; ' }
    Report sshd_config ($t.Code -eq 0 -and $missing.Count -eq 0) $ev
    $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
    Report sshd_service ($null -ne $svc -and "$($svc.Status)" -eq 'Running' -and "$($svc.StartType)" -eq 'Manual') "sshd $($svc.Status), $($svc.StartType) (started by the agent)"
    # build.json is written before sysprep: keys created after it belong to this clone.
    $seal = if (Test-Path -LiteralPath $BuildJson) { (Get-Item -LiteralPath $BuildJson).LastWriteTimeUtc } else { [datetime]::MaxValue }
    $keys = @(Get-ChildItem -LiteralPath $SshDataDir -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^ssh_host_\w+_key$' })
    $old = @($keys | Where-Object { $_.CreationTimeUtc -le $seal })
    $oldest = @($keys | ForEach-Object { $_.CreationTimeUtc.ToString('o') } | Sort-Object) | Select-Object -First 1
    Report ssh_host_keys ($keys.Count -ge 1 -and $old.Count -eq 0) "$($keys.Count) host keys ($(($keys | ForEach-Object Name) -join ', ')), oldest created $oldest; template build.json written $($seal.ToString('o'))"
    $shell = [string](Get-RegValue 'HKLM:\SOFTWARE\OpenSSH' 'DefaultShell')
    Report ssh_default_shell ($shell -eq $PwshExe) "DefaultShell $shell"
}

# [5] Certificate login of user with a test CA added to umiak_user_ca.pub for the check.
function Test-SshLogin {
    $dir = Join-Path $env:SystemRoot 'Temp\umiak-verify-ssh'
    $caFile = Join-Path $SshDataDir 'umiak_user_ca.pub'
    $keygen = Join-Path $OpenSshDir 'ssh-keygen.exe'
    $ssh = Join-Path $OpenSshDir 'ssh.exe'
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    New-Item -ItemType Directory -Path $dir | Out-Null
    $orig = $null
    try {
        # Private keys readable by SYSTEM only, or ssh refuses them.
        $acl = Invoke-Capture icacls.exe @($dir, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F')
        if ($acl.Code -ne 0) { throw "icacls: $($acl.Text)" }
        foreach ($k in @('ca', 'id')) {
            $r = Invoke-Capture $keygen @('-q', '-t', 'ed25519', '-N', '', '-C', "umiak-verify-$k", '-f', (Join-Path $dir $k))
            if ($r.Code -ne 0) { throw "ssh-keygen ${k}: $($r.Text)" }
        }
        $r = Invoke-Capture $keygen @('-q', '-s', (Join-Path $dir 'ca'), '-I', 'umiak-verify', '-n', $UserName, '-V', '-5m:+10m', (Join-Path $dir 'id.pub'))
        if ($r.Code -ne 0) { throw "ssh-keygen -s: $($r.Text)" }
        $orig = [IO.File]::ReadAllBytes($caFile)
        $caPub = [IO.File]::ReadAllText((Join-Path $dir 'ca.pub')).Trim()
        $text = [Text.Encoding]::UTF8.GetString($orig).TrimEnd()
        # Rewriting the existing file keeps the ACL sshd requires.
        [IO.File]::WriteAllText($caFile, $(if ($text) { "$text`n$caPub`n" } else { "$caPub`n" }), [Text.UTF8Encoding]::new($false))
        $r = Invoke-Capture $ssh @(
            '-i', (Join-Path $dir 'id'), '-o', "CertificateFile=$(Join-Path $dir 'id-cert.pub')",
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
            '-o', "UserKnownHostsFile=$(Join-Path $dir 'known_hosts')", '-o', 'ConnectTimeout=20',
            "$UserName@127.0.0.1", '$env:UMIAK')
        $last = @($r.Lines | Where-Object { $_.Trim() }) | Select-Object -Last 1
        Report ssh_cert_login ($r.Code -eq 0 -and "$last".Trim() -eq '1') "ssh with a test CA certificate as $UserName to 127.0.0.1, `$env:UMIAK in the session: exit $($r.Code), last line '$last'"
    } catch {
        Report ssh_cert_login $false "error: $($_.Exception.Message)"
    } finally {
        if ($null -ne $orig) { [IO.File]::WriteAllBytes($caFile, $orig) }
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# [6] Service, failure actions, early.json of this boot (doctor is checked by umiak-tpl).
function Test-Agent {
    $svc = Get-Service -Name umiak-agent -ErrorAction SilentlyContinue
    Report agent_service ($null -ne $svc -and "$($svc.Status)" -eq 'Running' -and "$($svc.StartType)" -eq 'Automatic') "umiak-agent $($svc.Status), $($svc.StartType)"
    $q = Invoke-Capture sc.exe @('qfailure', 'umiak-agent', '8192')
    $flag = Invoke-Capture sc.exe @('qfailureflag', 'umiak-agent')
    $restarts = [regex]::Matches($q.Text, '\bRESTART\b').Count
    $ok = $q.Code -eq 0 -and $restarts -ge 2 -and $q.Text -match 'RUN PROCESS' -and $q.Text -match 'rollback' -and
        $q.Text -match 'RESET_PERIOD[^:]*:\s*120\b' -and $flag.Text -match 'TRUE'
    $ev = @($q.Lines + $flag.Lines | Where-Object { $_ -match 'RESET_PERIOD|COMMAND_LINE|RESTART|RUN PROCESS|NONCRASH' } | ForEach-Object { $_.Trim() }) -join '; '
    Report agent_failure_actions $ok $ev
    $early = Join-Path $env:ProgramData 'umiak-agent\run\early.json'
    if (Test-Path -LiteralPath $early) {
        $at = (Get-Item -LiteralPath $early).LastWriteTimeUtc
        Report agent_early ($at -ge $BootTime) "$early written $($at.ToString('o')), boot $($BootTime.ToString('o'))"
    } else {
        Report agent_early $false "$early missing"
    }
}

# [7] Users, LSA secret, UAC without prompts.
function Test-Users {
    $admins = ([Security.Principal.SecurityIdentifier]'S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value.Split('\')[-1]
    $g = Invoke-Capture net.exe @('localgroup', $admins)
    $members = [Collections.Generic.List[string]]::new()
    $inList = $false
    foreach ($l in $g.Lines) {
        if ($l -match '^-{5,}') { $inList = $true; continue }
        if (-not $inList -or -not $l.Trim()) { continue }
        if ($l -match '^The command completed') { break }
        $members.Add(($l.Trim() -split '\\')[-1])
    }
    Report user_admin ($UserName -in $members) "${admins}: $($members -join ', ')"
    $accounts = @(Get-CimInstance -ClassName Win32_UserAccount -Filter 'LocalAccount=True')
    $u = @($accounts | Where-Object { $_.Name -eq $UserName }) | Select-Object -First 1
    if ($null -eq $u) {
        Report user_password $false "$UserName missing"
    } else {
        Report user_password (-not $u.Disabled -and -not $u.PasswordExpires) "$UserName disabled $($u.Disabled), password expires $($u.PasswordExpires)"
    }
    $lsa = Get-LsaSecretHash 'L$umiak_user' ''
    Report lsa_secret ($null -ne $lsa -and $lsa.Length -gt 0) $(if ($lsa) { "L`$umiak_user present ($($lsa.Length) bytes)" } else { 'L$umiak_user missing' })
    $enabled = @($accounts | Where-Object { -not $_.Disabled } | ForEach-Object Name)
    $disabled = @($accounts | Where-Object { $_.Disabled } | ForEach-Object Name)
    Report local_accounts (($enabled -join ',') -eq $UserName) "enabled: $($enabled -join ', '); disabled: $($disabled -join ', ')"
    $pol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    $lua = Get-RegValue $pol 'EnableLUA'
    $consent = Get-RegValue $pol 'ConsentPromptBehaviorAdmin'
    $secure = Get-RegValue $pol 'PromptOnSecureDesktop'
    Report uac ($lua -eq 1 -and $consent -eq 0 -and $secure -eq 0) "EnableLUA $lua, ConsentPromptBehaviorAdmin $consent, PromptOnSecureDesktop $secure"
}

# [7] Autologon: an active, unlocked console session of user, no logon screen in it (also run on a fork).
function Test-Autologon([int]$WaitSeconds = 180, [int]$PollSeconds = 5) {
    # The autologon can finish a while after the agent is ready (LogonUI stays until the
    # shell is up); the lock screen keeps LogonUI and shows as a locked session.
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ($true) {
        $q = Invoke-Capture query.exe @('user')
        $line = @($q.Lines | Where-Object { $_ -match "^\s*>?$UserName\s" -and $_ -match '\bActive\b' }) | Select-Object -First 1
        $sessionId = if ($line -and $line -match '\s(\d+)\s+Active\b') { [int]$Matches[1] } else { $null }
        $logonUi = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
        $mine = @($logonUi | Where-Object { $null -ne $sessionId -and $_.SessionId -eq $sessionId })
        $lock = if ($null -ne $sessionId) { Get-SessionLockState $sessionId } else { 'unknown' }
        $lockApp = @(Get-Process -Name LockApp -ErrorAction SilentlyContinue | Where-Object { $null -ne $sessionId -and $_.SessionId -eq $sessionId })
        # A locked Windows 11 session runs LogonUI and LockApp in it. The WTSSessionInfoEx flag is
        # only reported: on 26H2 it said 'locked' for a session with neither (seen on pve).
        $ok = $null -ne $sessionId -and $mine.Count -eq 0 -and $lockApp.Count -eq 0
        if ($ok -or (Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds $PollSeconds
    }
    $ev = if ($null -eq $sessionId) {
        "no active session of ${UserName}: $($q.Lines -join ' | ')"
    } else {
        "query user: $($line.Trim()); session $sessionId, WTSSessionInfoEx flag $lock"
    }
    $ui = if ($logonUi.Count) { ($logonUi | ForEach-Object { "LogonUI in session $($_.SessionId)" }) -join ', ' } else { 'no LogonUI' }
    Report autologon_session $ok "$ev; $ui; LockApp in the session: $(if ($lockApp.Count) { 'running' } else { 'no' }); waited up to $WaitSeconds s"
}

# [8] Services, Defender, offline stage, power, memory, VBS, BitLocker, TPM, BCD, WinRE, code page.
function Test-Services {
    $bad = [Collections.Generic.List[string]]::new()
    $absent = [Collections.Generic.List[string]]::new()
    foreach ($s in $DisabledServices) {
        $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
        if ($null -eq $svc) { $absent.Add($s); continue }
        if ("$($svc.StartType)" -ne 'Disabled' -or "$($svc.Status)" -eq 'Running') { $bad.Add("$s $($svc.Status)/$($svc.StartType)") }
    }
    Report services_disabled ($bad.Count -eq 0) "not disabled: $(if ($bad.Count) { $bad -join ', ' } else { 'none' }); absent: $(if ($absent.Count) { $absent -join ', ' } else { 'none' })"

    $def = [Collections.Generic.List[string]]::new()
    $defBad = 0
    foreach ($s in $DefenderServices) {
        $v = Get-RegValue "$ServicesKey\$s" 'Start'
        if ($null -eq $v) { $def.Add("$s absent"); continue }
        $def.Add("$s Start=$v")
        if ($v -ne 4) { $defBad++ }
    }
    $engine = @(Get-Process -Name MsMpEng -ErrorAction SilentlyContinue).Count -gt 0
    Report defender_off ($defBad -eq 0 -and -not $engine) "$($def -join ', '); MsMpEng running: $engine"
    $medic = Get-RegValue "$ServicesKey\WaaSMedicSvc" 'Start'
    Report waasmedic_off ($medic -eq 4) "WaaSMedicSvc Start=$medic"

    $log = Join-Path $env:SystemRoot 'Setup\Scripts\umiak-offline.log'
    if (Test-Path -LiteralPath $log) {
        $lines = @(Get-Content -LiteralPath $log)
        $errors = @($lines | Where-Object { $_ -match '^\s*ERROR\b' })
        $done = @($lines | Where-Object { $_ -match '^DONE errors' }) | Select-Object -Last 1
        Report offline_log ($errors.Count -eq 0 -and "$done" -match '^DONE errors 0\s*$') "$($lines.Count) lines, '$done', ERROR lines: $(if ($errors.Count) { $errors -join '; ' } else { 'none' })"
    } else {
        Report offline_log $false "$log missing"
    }

    $hiberboot = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' 'HiberbootEnabled'
    Report fast_startup_off ($hiberboot -eq 0) "HiberbootEnabled $hiberboot"
    $hibernate = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' 'HibernateEnabled'
    $hiberfil = Test-Path -LiteralPath (Join-Path $env:SystemDrive 'hiberfil.sys')
    Report hibernation_off ($hibernate -eq 0 -and -not $hiberfil) "HibernateEnabled $hibernate, hiberfil.sys present: $hiberfil"
    $mm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
    $pf = @(Get-CimInstance -ClassName Win32_PageFileUsage)
    $clear = Get-RegValue $mm 'ClearPageFileAtShutdown'
    Report pagefile ($pf.Count -ge 1 -and $clear -eq 1) "pagefile: $(($pf | ForEach-Object { "$($_.Name) $($_.AllocatedBaseSize) MB" }) -join ', '); ClearPageFileAtShutdown $clear"
    $dump = Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' 'CrashDumpEnabled'
    Report crash_dump ($dump -eq 0) "CrashDumpEnabled $dump"
    $dg = Get-CimInstance -Namespace 'root\Microsoft\Windows\DeviceGuard' -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue
    $vbs = if ($dg) { [int]$dg.VirtualizationBasedSecurityStatus } else { -1 }
    Report vbs_off ($vbs -eq 0) "VirtualizationBasedSecurityStatus $vbs, services running: $(if ($dg) { @($dg.SecurityServicesRunning) -join ',' } else { 'unknown' })"

    $bde = Join-Path $env:SystemRoot 'System32\manage-bde.exe'
    if (Test-Path -LiteralPath $bde) {
        $r = Invoke-Capture $bde @('-status', 'C:')
        $conv = @($r.Lines | Where-Object { $_ -match '^\s*Conversion Status:\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1
        $prot = @($r.Lines | Where-Object { $_ -match '^\s*Protection Status:\s*(.+)$' } | ForEach-Object { $Matches[1].Trim() }) | Select-Object -First 1
        Report bitlocker_off ($conv -eq 'Fully Decrypted' -and $prot -eq 'Protection Off') "C: '$conv', '$prot'"
    } else {
        Report bitlocker_off $true 'manage-bde not part of the edition'
    }

    $tpm = Get-CimInstance -Namespace 'root\cimv2\Security\MicrosoftTpm' -ClassName Win32_Tpm -ErrorAction SilentlyContinue
    if ($tpm) {
        $ready = (Invoke-CimMethod -InputObject $tpm -MethodName IsReady).IsReady
        Report tpm_ready ([bool]$ready) "TPM $($tpm.SpecVersion), manufacturer $($tpm.ManufacturerIdTxt), ready $ready"
    } else {
        Report tpm_ready $false 'no Win32_Tpm instance'
    }

    $bcd = Invoke-Capture bcdedit.exe @('/enum', '{current}')
    $policy = @($bcd.Lines | Where-Object { $_ -match '^bootstatuspolicy\s+(\S+)' } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
    $recovery = @($bcd.Lines | Where-Object { $_ -match '^recoveryenabled\s+(\S+)' } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
    Report bcd ($policy -eq 'IgnoreAllFailures' -and $recovery -eq 'No') "bootstatuspolicy $policy, recoveryenabled $recovery"
    $re = Invoke-Capture reagentc.exe @('/info')
    $reStatus = @($re.Lines | Where-Object { $_ -match 'Windows RE status:\s*(\S+)' } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
    Report winre_off ($reStatus -eq 'Disabled') "Windows RE status $reStatus"
    # firstboot.ps1 writes them; they apply at the next boot (the agent's rename reboot).
    $nls = 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage'
    $acp = Get-RegValue $nls 'ACP'
    $oem = Get-RegValue $nls 'OEMCP'
    if (-not ('UmiakNls' -as [type])) {
        Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class UmiakNls { [DllImport("kernel32.dll")] public static extern uint GetACP(); [DllImport("kernel32.dll")] public static extern uint GetOEMCP(); }'
    }
    $activeAcp = [UmiakNls]::GetACP()
    $activeOem = [UmiakNls]::GetOEMCP()
    Report codepage ($acp -eq '65001' -and $oem -eq '65001' -and $activeAcp -eq 65001 -and $activeOem -eq 65001) "registry ACP $acp, OEMCP $oem; active GetACP() $activeAcp, GetOEMCP() $activeOem"
}

# [9] Tool versions as user (direct argv and the pwsh shell path), npm global prefix.
function Test-Tools {
    # agent CLI contract — see apps/template-builder/src/windows/verify.ts (agentExecCmd)
    $result = [ordered]@{}
    foreach ($t in @($Tools -split ',' | Where-Object { $_ })) {
        $arg = if ($t -eq 'go') { 'version' } else { '--version' }
        $direct = Get-FirstLine (Invoke-Capture $AgentExe @('exec', '--user', $UserName, '--', $t, $arg))
        $login = Get-FirstLine (Invoke-Capture $AgentExe @('exec', '--user', $UserName, '--shell', "$t $arg"))
        $result[$t] = [ordered]@{ direct = $direct; login = $login }
    }
    [Console]::Out.WriteLine('TOOLS ' + (ConvertTo-Json -InputObject $result -Compress -Depth 3))
    $prefix = Get-FirstLine (Invoke-Capture $AgentExe @('exec', '--user', $UserName, '--', 'npm', 'config', 'get', 'prefix'))
    Report npm_prefix ($prefix -eq $NpmPrefix) "npm config get prefix as ${UserName}: $prefix, want $NpmPrefix"
}

# [10] IPv4 in the sandbox subnet, DNS, HTTPS, clock against the host, UTC.
function Test-Network {
    $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object IPAddress)
    $in = @($ips | Where-Object { Test-InCidr $_ $ExpectSubnet })
    Report ipv4 ($in.Count -ge 1) "IPv4 $($ips -join ', '), want one in $ExpectSubnet"
    try {
        $a = @(Resolve-DnsName -Name example.com -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.Type -eq 'A' })
        Report dns ($a.Count -ge 1) "example.com A $(($a | ForEach-Object IPAddress) -join ', ')"
    } catch {
        Report dns $false "example.com: $($_.Exception.Message)"
    }
    try {
        $r = Invoke-WebRequest -Uri 'https://example.com' -UseBasicParsing -TimeoutSec 30
        Report https ($r.StatusCode -eq 200) "https://example.com HTTP $($r.StatusCode)"
    } catch {
        Report https $false "https://example.com: $($_.Exception.Message)"
    }
    $w = Invoke-Capture w32tm.exe @('/query', '/status')
    $source = @($w.Lines | Where-Object { $_ -match '^Source:' }) | Select-Object -First 1
    if ($HostUnixMs -gt 0) {
        $skew = $StartedUnixMs - $HostUnixMs
        Report time_sync ([math]::Abs($skew) -le 10000) "guest clock $skew ms after the host's at the start of this script (limit 10000, includes the QGA start); w32time $source"
    } else {
        Report time_sync INFO "no -HostUnixMs; w32time $source"
    }
    $tz = (Get-TimeZone).Id
    Report timezone ($tz -eq 'UTC') "time zone $tz"
}

# [16] TRIM: a warning until the pinned virtio-win has the vioscsi fix (spec 23).
function Test-Trim {
    try {
        Optimize-Volume -DriveLetter C -ReTrim -ErrorAction Stop
        Report trim $true 'Optimize-Volume -ReTrim on C: succeeded'
    } catch {
        Report trim INFO "warning: Optimize-Volume -ReTrim: $($_.Exception.Message)"
    }
}

# [17] Licence state for the manifest; umiak-tpl judges it by the channel.
function Test-License {
    $cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $names = @('Unlicensed', 'Licensed', 'OOBGrace', 'OOTGrace', 'NonGenuineGrace', 'Notification', 'ExtendedGrace')
    $lic = [ordered]@{ status = $null; description = $null; graceMinutes = $null; evaluationEnd = $null; editionId = [string]$cv.EditionID }
    $p = @(Get-CimInstance -ClassName SoftwareLicensingProduct -Filter "ApplicationID = '55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL") | Select-Object -First 1
    if ($p) {
        $st = [int]$p.LicenseStatus
        $lic.status = if ($st -ge 0 -and $st -lt $names.Count) { $names[$st] } else { "status $st" }
        $lic.description = [string]$p.Description
        $lic.graceMinutes = [long]$p.GracePeriodRemaining
        $end = $p.EvaluationEndDate
        if ($end -is [datetime] -and $end.Year -gt 1700) { $lic.evaluationEnd = $end.ToUniversalTime().ToString('o') }
    }
    [Console]::Out.WriteLine('LICENSE ' + (ConvertTo-Json -InputObject $lic -Compress))
}

# [18] Build leftovers.
function Test-Leftovers {
    $bad = [Collections.Generic.List[string]]::new()
    if (Test-Path -LiteralPath 'C:\umiak-build') { $bad.Add('C:\umiak-build') }
    foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $env:SystemRoot 'Temp') -Recurse -Force -File -Include '*.msi', '*.msu', '*.exe', '*.zip' -ErrorAction SilentlyContinue)) {
        $bad.Add($f.FullName)
    }
    foreach ($f in @(Get-ChildItem -LiteralPath 'C:\Users', $SshDataDir -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*authorized_keys*' })) {
        $bad.Add($f.FullName)
    }
    if (-not (Test-Path -LiteralPath $BuildJson)) { $bad.Add("$BuildJson missing") }
    Report leftovers ($bad.Count -eq 0) $(if ($bad.Count) { $bad -join ', ' } else { "no C:\umiak-build, installers or authorized_keys; $BuildJson present" })
}

# [12] No VSS errors since this boot (after a QGA freeze and thaw). Event 8194 "Unexpected
# error querying for the IVssWriterCallback interface. hr = 0x80070005" is the known benign
# COM security message of the qemu-ga VSS requestor; it is reported as INFO, not a failure.
function Test-VssEvents {
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'VSS'; Level = 1, 2; StartTime = $BootTime } -ErrorAction SilentlyContinue)
    $known = @($ev | Where-Object { $_.Id -eq 8194 -and $_.Message -match 'IVssWriterCallback' -and $_.Message -match '0x80070005' })
    $bad = @($ev | Where-Object { $known -notcontains $_ })
    if ($bad.Count) {
        $ignored = if ($known.Count) { "; $($known.Count) known benign 8194 ignored" } else { '' }
        Report vss_events $false "$($bad.Count) VSS errors: $(($bad | Select-Object -First 3 | ForEach-Object { "$($_.Id) $($_.Message)" }) -join ' | ')$ignored"
    } elseif ($known.Count) {
        Report vss_events INFO "$($known.Count) known benign event 8194 (IVssWriterCallback hr = 0x80070005, qemu-ga VSS requestor COM security); no other VSS errors"
    } else {
        Report vss_events $true 'no VSS errors since boot'
    }
}

# Salted hash of the password of user (fork: unchanged).
function Test-LsaHash {
    $h = Get-LsaSecretHash 'L$umiak_user' $Salt
    Report lsa_hash INFO $(if ($h) { $h.Hash } else { 'missing' })
}

# Identity facts of a fork comparison.
function Test-Facts {
    $active = [string](Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName' 'ComputerName')
    $guid = [string](Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Cryptography' 'MachineGuid')
    $h = Get-LsaSecretHash 'L$umiak_user' $Salt
    $keygen = Join-Path $OpenSshDir 'ssh-keygen.exe'
    $keys = @(Get-ChildItem -LiteralPath $SshDataDir -Force -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^ssh_host_\w+_key\.pub$' } |
            ForEach-Object {
                $r = Invoke-Capture $keygen @('-lf', $_.FullName)
                if ($r.Code -eq 0) { (@($r.Lines)[0] -split '\s+')[1] }
            })
    $boots = $null
    if ($Since) {
        $t = [DateTimeOffset]::Parse($Since, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
        $boots = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 6005; StartTime = $t } -ErrorAction SilentlyContinue).Count
    }
    $f = [ordered]@{
        computerName = $active
        machineGuid = $guid
        lsaHash = if ($h) { $h.Hash } else { '' }
        hostKeys = @($keys)
        bootsSince = $boots
    }
    [Console]::Out.WriteLine('FACTS ' + (ConvertTo-Json -InputObject $f -Compress -Depth 3))
}

# --- main ---

$Groups = [ordered]@{
    os = { Test-Os }
    identity = { Test-Identity }
    first_boot = { Test-FirstBoot }
    unattend = { Test-Unattend }
    listeners = { Test-Listeners }
    firewall = { Test-Firewall }
    sshd = { Test-Sshd }
    ssh_login = { Test-SshLogin }
    agent = { Test-Agent }
    users = { Test-Users }
    autologon = { Test-Autologon }
    services = { Test-Services }
    tools = { Test-Tools }
    network = { Test-Network }
    trim = { Test-Trim }
    license = { Test-License }
    leftovers = { Test-Leftovers }
    vss_events = { Test-VssEvents }
    lsa_hash = { Test-LsaHash }
    facts = { Test-Facts }
}
$OnDemand = @('vss_events', 'lsa_hash', 'facts')
# Desktop profiles (S10) are spliced in before "# --- main ---" and add their groups here.
if (Test-Path variable:UmiakExtraGroups) {
    foreach ($k in $UmiakExtraGroups.Keys) { $Groups[$k] = $UmiakExtraGroups[$k] }
}

$BootTime = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime()
$selected = if ($Check) {
    @($Check -split ',' | ForEach-Object { $_.Trim().Replace('-', '_') } | Where-Object { $_ })
} else {
    @($Groups.Keys | Where-Object { $_ -notin $OnDemand })
}
foreach ($g in $selected) {
    if (-not $Groups.Contains($g)) {
        Report $g $false 'unknown check'
        continue
    }
    try {
        & $Groups[$g]
    } catch {
        Report $g $false "error: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
    }
}
exit 0
