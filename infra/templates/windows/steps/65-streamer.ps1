#requires -Version 7
# S10 overlay on S9's Windows recipe; no VM or firewall management here.
. (Join-Path $PSScriptRoot '..\lib.ps1')
. (Join-Path $SbxFilesDir 'desktop-install.ps1')
Install-SbxDesktop -ProgramRoot $env:ProgramFiles -AgentRoot (Join-Path $env:ProgramData 'sbx-agent') -WorkRoot (Join-Path $SbxWorkDir 'desktop') -FilesRoot $SbxFilesDir
Write-BuildLog 'S10 desktop streamers installed; services remain Manual'
