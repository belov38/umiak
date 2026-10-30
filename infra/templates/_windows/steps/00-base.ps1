# 00-base (spec S9 section 8.1): policies before the network comes up,
# services, power and boot, memory, locale, firewall, Appx. The NIC link is
# still down; the builder reboots after this step. Windows PowerShell 5.1.
. (Join-Path $PSScriptRoot '..\lib.ps1')

$policies = 'HKLM:\SOFTWARE\Policies\Microsoft'
$cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
Write-BuildLog "edition $($cv.EditionID), build $($cv.CurrentBuild).$($cv.UBR)"

# --- Policies (before network) ---
# Windows Update: no automatic updates. Its servers stay reachable: 10-system
# installs OpenSSH from them; wuauserv is disabled in 90-cleanup.
Set-RegValue "$policies\Windows\WindowsUpdate\AU" NoAutoUpdate 1
Set-RegValue "$policies\Windows\WindowsUpdate" ExcludeWUDriversInQualityUpdate 1
# Store: no automatic app updates.
Set-RegValue "$policies\WindowsStore" AutoDownload 2
# Consumer features, cloud content, tips.
Set-RegValue "$policies\Windows\CloudContent" DisableWindowsConsumerFeatures 1
Set-RegValue "$policies\Windows\CloudContent" DisableConsumerAccountStateContent 1
Set-RegValue "$policies\Windows\CloudContent" DisableCloudOptimizedContent 1
Set-RegValue "$policies\Windows\CloudContent" DisableSoftLanding 1
# Delivery Optimization: no peering, no DO cloud service (99 = simple mode).
Set-RegValue "$policies\Windows\DeliveryOptimization" DODownloadMode 99
# Telemetry: the lowest level the edition honours.
$telemetry = if ($cv.EditionID -match '^(Enterprise|Education|Server|IoTEnterprise)') { 0 } else { 1 }
Set-RegValue "$policies\Windows\DataCollection" AllowTelemetry $telemetry
Set-RegValue "$policies\Windows\DataCollection" DoNotShowFeedbackNotifications 1
Set-RegValue "$policies\Windows\DataCollection" AllowDeviceNameInTelemetry 0
# Error Reporting.
Set-RegValue "$policies\Windows\Windows Error Reporting" Disabled 1
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' Disabled 1
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting' DontShowUI 1
# Edge: no first run, no background mode or startup boost. Its update
# policies only apply to managed devices: the edgeupdate services and tasks
# are disabled below.
Set-RegValue "$policies\Edge" HideFirstRunExperience 1
Set-RegValue "$policies\Edge" BackgroundModeEnabled 0
Set-RegValue "$policies\Edge" StartupBoostEnabled 0
Set-RegValue "$policies\Edge" ShowRecommendationsEnabled 0
Set-RegValue "$policies\EdgeUpdate" UpdateDefault 0
Set-RegValue "$policies\EdgeUpdate" AutoUpdateCheckPeriodMinutes 0
# Copilot, Widgets, Start recommendations.
Set-RegValue "$policies\Windows\WindowsCopilot" TurnOffWindowsCopilot 1
Set-RegValue "$policies\Dsh" AllowNewsAndInterests 0
Set-RegValue "$policies\Windows\Explorer" HideRecommendedSection 1
# Windows Search: no web results, no Cortana.
Set-RegValue "$policies\Windows\Windows Search" AllowCortana 0
Set-RegValue "$policies\Windows\Windows Search" DisableWebSearch 1
Set-RegValue "$policies\Windows\Windows Search" ConnectedSearchUseWeb 0
# OneDrive: never set up (the Default User Run entry goes in 60-desktop).
Set-RegValue "$policies\Windows\OneDrive" DisableFileSyncNGSC 1
# Name resolution multicast: no LLMNR, no mDNS, NetBIOS P-node (no broadcasts).
Set-RegValue "$policies\Windows NT\DNSClient" EnableMulticast 0
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters' EnableMDNS 0
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Services\NetBT\Parameters' NodeType 2

# --- Services ---
foreach ($s in ($SbxDisabledServices | Where-Object { $_ -notin $SbxUpdateServices })) {
    Disable-SbxService -Name $s
}
foreach ($s in @('edgeupdate', 'edgeupdatem')) { Disable-SbxService -Name $s }
# fsfreeze of QGA runs on VSS (spec 12.10).
foreach ($s in @('VSS', 'swprv')) { Set-SbxServiceStartup -Name $s -StartupType Manual }
# Time sync must work after hard stops and long pauses.
Set-SbxServiceStartup -Name W32Time -StartupType Automatic

# Maintenance tasks. Their set differs between builds: a missing task is skipped.
$tasks = @(
    '\Microsoft\Windows\Defrag\ScheduledDefrag',
    '\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser',
    '\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser Exp',
    '\Microsoft\Windows\Application Experience\ProgramDataUpdater',
    '\Microsoft\Windows\Application Experience\StartupAppTask',
    '\Microsoft\Windows\Application Experience\PcaPatchDbTask',
    '\Microsoft\Windows\Customer Experience Improvement Program\Consolidator',
    '\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip',
    '\Microsoft\Windows\Customer Experience Improvement Program\KernelCeipTask',
    '\Microsoft\Windows\DiskDiagnostic\Microsoft-Windows-DiskDiagnosticDataCollector',
    '\Microsoft\Windows\Autochk\Proxy',
    '\Microsoft\Windows\Feedback\Siuf\DmClient',
    '\Microsoft\Windows\Feedback\Siuf\DmClientOnScenarioDownload',
    '\Microsoft\Windows\Windows Error Reporting\QueueReporting',
    '\Microsoft\Windows\Maps\MapsUpdateTask',
    '\Microsoft\Windows\Maps\MapsToastTask',
    '\Microsoft\Windows\SystemRestore\SR',
    '\Microsoft\Windows\WindowsUpdate\Scheduled Start'
)
foreach ($t in $tasks) {
    $path = $t.Substring(0, $t.LastIndexOf('\') + 1)
    $name = $t.Substring($t.LastIndexOf('\') + 1)
    $task = Get-ScheduledTask -TaskPath $path -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) { Write-BuildLog "task ${t}: not present"; continue }
    # Some builds protect single tasks even from SYSTEM; that is not worth a failed build.
    try {
        Disable-ScheduledTask -InputObject $task | Out-Null
        Write-BuildLog "task ${t}: disabled"
    } catch {
        Write-BuildLog "WARNING: task ${t}: $($_.Exception.Message)"
    }
}
Get-ScheduledTask -TaskPath '\' -ErrorAction SilentlyContinue |
    Where-Object { $_.TaskName -like 'MicrosoftEdgeUpdateTask*' } |
    ForEach-Object { Disable-ScheduledTask -InputObject $_ | Out-Null; Write-BuildLog "task $($_.TaskName): disabled" }
# Automatic maintenance.
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\Maintenance' MaintenanceDisabled 1

# --- Power and boot ---
$highPerf = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'
$schemes = Get-NativeOutput -FilePath powercfg.exe -ArgumentList @('/list')
if (-not ($schemes -match $highPerf)) {
    Invoke-Native -FilePath powercfg.exe -ArgumentList @('/duplicatescheme', $highPerf, $highPerf)
}
Invoke-Native -FilePath powercfg.exe -ArgumentList @('/setactive', $highPerf)
foreach ($setting in @('standby-timeout', 'monitor-timeout', 'hibernate-timeout', 'disk-timeout')) {
    foreach ($src in @('ac', 'dc')) {
        Invoke-Native -FilePath powercfg.exe -ArgumentList @('/change', "$setting-$src", '0')
    }
}
Invoke-Native -FilePath powercfg.exe -ArgumentList @('/hibernate', 'off')
# Fast Startup is hibernation of the kernel session.
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' HiberbootEnabled 0
# A hard stop must never lead to Automatic Repair.
Invoke-Native -FilePath bcdedit.exe -ArgumentList @('/set', '{current}', 'bootstatuspolicy', 'ignoreallfailures')
Invoke-Native -FilePath bcdedit.exe -ArgumentList @('/set', '{current}', 'recoveryenabled', 'no')
$re = Get-NativeOutput -FilePath reagentc.exe -ArgumentList @('/info')
if ($re -match 'Windows RE status:\s+Enabled') {
    Invoke-Native -FilePath reagentc.exe -ArgumentList @('/disable')
} else {
    Write-BuildLog 'WinRE is already disabled'
}

# --- Memory and secrets (spec 12.8) ---
# A fixed 2 GiB pagefile on C: (not system managed), cleared at shutdown; no crash dumps.
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
if ($cs.AutomaticManagedPagefile) { Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } }
$mm = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management'
Set-RegValue $mm PagingFiles @('C:\pagefile.sys 2048 2048') MultiString
Set-RegValue $mm ClearPageFileAtShutdown 1
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' CrashDumpEnabled 0
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl' AlwaysKeepMemoryDump 0
# System Restore and scheduled shadow copies off; VSS itself stays (Manual, above).
try {
    Disable-ComputerRestore -Drive 'C:\'
} catch {
    # The DisableSR policy below covers it.
    Write-BuildLog "WARNING: Disable-ComputerRestore: $($_.Exception.Message)"
}
Set-RegValue "$policies\Windows NT\SystemRestore" DisableSR 1
Set-RegValue "$policies\Windows NT\SystemRestore" DisableConfig 1
Invoke-Native -FilePath vssadmin.exe -ArgumentList @('delete', 'shadows', '/all', '/quiet') -SuccessCodes @(0, 1, 2)

# --- Locale, code page, file system ---
Invoke-Native -FilePath tzutil.exe -ArgumentList @('/s', 'UTC')
if ((Get-WinSystemLocale).Name -ne 'en-US') { Set-WinSystemLocale -SystemLocale en-US }
# UTF-8 as the system code page (after the locale, which writes its own code pages).
$cp = 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage'
foreach ($n in @('ACP', 'OEMCP', 'MACCP')) { Set-RegValue $cp $n '65001' String }
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1
# Developer Mode: symbolic links without elevation.
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' AllowDevelopmentWithoutDevLicense 1
Set-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' AllowAllTrustedApps 1

# --- VBS, HVCI, Credential Guard off: with cpu=host Windows would run Hyper-V under itself ---
$dg = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard'
Set-RegValue $dg EnableVirtualizationBasedSecurity 0
Set-RegValue $dg RequirePlatformSecurityFeatures 0
Set-RegValue "$dg\Scenarios\HypervisorEnforcedCodeIntegrity" Enabled 0
Set-RegValue "$dg\Scenarios\CredentialGuard" Enabled 0
Set-RegValue "$policies\Windows\DeviceGuard" EnableVirtualizationBasedSecurity 0
Set-RegValue "$policies\Windows\DeviceGuard" HypervisorEnforcedCodeIntegrity 0
Set-RegValue "$policies\Windows\DeviceGuard" LsaCfgFlags 0
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' LsaCfgFlags 0
Invoke-Native -FilePath bcdedit.exe -ArgumentList @('/set', '{current}', 'hypervisorlaunchtype', 'off')

# --- Time: NTP, any step size (large jumps after a pause or restore) ---
$w32 = 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time'
Set-RegValue "$w32\Parameters" Type 'NTP' String
Set-RegValue "$w32\Parameters" NtpServer 'time.windows.com,0x9' String
Set-RegValue "$w32\Config" MaxPosPhaseCorrection 0xFFFFFFFF
Set-RegValue "$w32\Config" MaxNegPhaseCorrection 0xFFFFFFFF

# --- Firewall: on everywhere, inbound blocked, no allow-inbound rule, no listen prompts ---
Set-NetFirewallProfile -All -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow -NotifyOnListen False
$allow = @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue)
if ($allow.Count -gt 0) { $allow | Disable-NetFirewallRule }
Write-BuildLog "firewall: $($allow.Count) inbound allow rules disabled"

# --- BitLocker: never encrypt (also set in specialize of the install) ---
Set-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLocker' PreventDeviceEncryption 1
$manageBde = Join-Path $env:SystemRoot 'System32\manage-bde.exe'
if (Test-Path -LiteralPath $manageBde) {
    $bde = Get-NativeOutput -FilePath $manageBde -ArgumentList @('-status', 'C:') -SuccessCodes @(0, -1)
    if (($bde -match 'Conversion Status:') -and -not ($bde -match 'Conversion Status:\s+Fully Decrypted')) {
        Write-BuildLog 'C: is encrypted or encrypting: turning BitLocker off'
        Invoke-Native -FilePath $manageBde -ArgumentList @('-off', 'C:')
    }
}

# --- Appx: provisioned packages of files\appx-remove.txt (display name or * pattern) ---
$patterns = @(Get-Content -LiteralPath (Join-Path $SbxFilesDir 'appx-remove.txt') |
    ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
$provisioned = @(Get-AppxProvisionedPackage -Online)
foreach ($p in $patterns) {
    $matched = @($provisioned | Where-Object { $_.DisplayName -like $p })
    if ($matched.Count -eq 0) { Write-BuildLog "appx ${p}: not provisioned"; continue }
    foreach ($m in $matched) {
        Remove-AppxProvisionedPackage -Online -AllUsers -PackageName $m.PackageName | Out-Null
        Write-BuildLog "appx $($m.PackageName): removed"
    }
}

Write-BuildLog 'done'
