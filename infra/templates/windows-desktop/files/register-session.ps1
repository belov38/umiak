param([Parameter(Mandatory)][string]$Socket)
$ErrorActionPreference='Stop'
# The user account is created by S9 identity apply, so registration belongs to claim-time.
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
try{[void]$scheduler.GetFolder('\sbx')}catch{[void]$scheduler.GetFolder('\').CreateFolder('sbx')}
$binary=Join-Path $env:ProgramFiles 'sbx-agent\current\sbx-agent.exe'
$action=New-ScheduledTaskAction -Execute $binary -Argument ("session --socket `"$Socket`"")
$principal=New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\user" -LogonType Interactive -RunLevel Highest
$trigger=New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\user"
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName session -TaskPath '\sbx\' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
$pwsh=Join-Path $PSHOME 'pwsh.exe'
$cuaScript=Join-Path $PSScriptRoot 'run-cua.ps1'
$cuaAction=New-ScheduledTaskAction -Execute $pwsh -Argument ("-NoLogo -NoProfile -WindowStyle Hidden -File `"$cuaScript`"")
Register-ScheduledTask -TaskName cua-driver -TaskPath '\sbx\' -Action $cuaAction -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null
# Before the autologon of user an interactive task cannot start; the logon trigger starts both.
# The agent calls this script on every start, so a running helper is also kept.
if ((Get-CimInstance -ClassName Win32_ComputerSystem).UserName) {
    foreach ($task in @('session', 'cua-driver')) {
        try { Start-ScheduledTask -TaskName $task -TaskPath '\sbx\' } catch { Write-Warning "start ${task}: $_" }
    }
}
