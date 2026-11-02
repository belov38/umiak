# 10-system (spec S9 sections 8.2-8.4): PowerShell 7, OpenSSH Server from the
# Feature on Demand, accounts, UAC. Runs after network-up: the FoD comes from
# Windows Update. Windows PowerShell 5.1; the steps after this one run in pwsh.
. (Join-Path $PSScriptRoot '..\lib.ps1')

# --- PowerShell 7 (all users, in Path, no telemetry, no Microsoft Update opt-in) ---
Set-MachineEnv POWERSHELL_TELEMETRY_OPTOUT 1
$pwshVersion = Get-ToolVersion 'pwsh'
$installed = if (Test-Path -LiteralPath $UmiakPwshExe) { (Get-Item -LiteralPath $UmiakPwshExe).VersionInfo.ProductVersion } else { '' }
if ("$installed" -like "$pwshVersion*") {
    Write-BuildLog "PowerShell $installed is installed"
} else {
    $msi = Get-ToolFile -Name 'pwsh'
    Invoke-Msi -Path $msi -Properties @(
        'ADD_PATH=1', 'DISABLE_TELEMETRY=1', 'ENABLE_PSREMOTING=0', 'REGISTER_MANIFEST=1',
        'USE_MU=0', 'ENABLE_MU=0',
        'ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=0', 'ADD_FILE_CONTEXT_MENU_RUNPOWERSHELL=0'
    )
}
if (-not (Test-Path -LiteralPath $UmiakPwshExe)) { throw "$UmiakPwshExe is missing after the install" }
Invoke-Native -FilePath $UmiakPwshExe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()')

# --- OpenSSH Server ---
$source = [string](Get-BuildVersionInfo).openssh.source
if ($source -ne 'inbox') { throw "openssh source '$source' is not supported by this step (only inbox)" }
$capability = 'OpenSSH.Server~~~~0.0.1.0'
for ($i = 1; ; $i++) {
    if ((Get-WindowsCapability -Online -Name $capability).State -eq 'Installed') { break }
    try {
        Write-BuildLog "Add-WindowsCapability $capability (try $i)"
        Add-WindowsCapability -Online -Name $capability | Out-Null
    } catch {
        if ($i -ge 3) { throw }
        Write-BuildLog "Add-WindowsCapability failed: $($_.Exception.Message); retrying in 30 s"
        Start-Sleep -Seconds 30
    }
}
Write-BuildLog "$capability installed"
$sshd = Get-Command -Name (Join-Path $env:SystemRoot 'System32\OpenSSH\sshd.exe') -ErrorAction SilentlyContinue
if ($null -eq $sshd) { throw 'sshd.exe is missing after the capability install' }
Write-BuildLog "sshd $($sshd.FileVersionInfo.ProductVersion)"

# The agent starts sshd once the identity (host keys) is ready (spec 12.3).
if ((Get-Service -Name sshd).Status -ne 'Stopped') { Stop-Service -Name sshd -Force }
Set-UmiakServiceStartup -Name sshd -StartupType Manual
$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($rule) { Remove-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'; Write-BuildLog 'firewall rule OpenSSH-Server-In-TCP removed' }

# C:\ProgramData\ssh with the ACL sshd itself sets on first start: only SYSTEM
# and Administrators write, authenticated users read.
$sshDir = Join-Path $env:ProgramData 'ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
Invoke-Native -FilePath icacls.exe -ArgumentList @($sshDir, '/inheritance:r', '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', '/grant', '*S-1-5-11:(OI)(CI)RX')
Copy-BuildFile -Name 'sshd_config' -Destination (Join-Path $sshDir 'sshd_config')
# Host keys of the build are never used: identity apply creates new ones on every clone.
Get-ChildItem -LiteralPath $sshDir -Filter 'ssh_host_*' -Force | Remove-Item -Force
Set-RegValue 'HKLM:\SOFTWARE\OpenSSH' DefaultShell $UmiakPwshExe String

# --- Accounts (spec 8.2) ---
$user = Get-LocalUser -Name 'user'
Set-LocalUser -Name 'user' -PasswordNeverExpires $true
$admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID -eq $user.SID })
if ($admins.Count -eq 0) { throw 'user is not in Administrators' }
# Built-in Administrator (-500), Guest (-501), DefaultAccount (-503), WDAGUtilityAccount (-504).
foreach ($a in @(Get-LocalUser | Where-Object { $_.SID.Value -match '-(500|501|503|504)$' })) {
    if ($a.Enabled) { Disable-LocalUser -SID $a.SID; Write-BuildLog "account $($a.Name): disabled" }
}
$enabled = @(Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { $_.Name })
if ($enabled.Count -ne 1 -or $enabled[0] -ne 'user') { throw "enabled local accounts: $($enabled -join ', '); want only user" }

# --- UAC on, without prompts (MSIX apps need EnableLUA=1) ---
$sys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-RegValue $sys EnableLUA 1
Set-RegValue $sys ConsentPromptBehaviorAdmin 0
Set-RegValue $sys PromptOnSecureDesktop 0

Write-BuildLog 'done'
