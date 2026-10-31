#requires -Version 7
# 65-streamer (spec S10 section 7): Sunshine, moonlight-web and cua-driver on top of the
# S9 image. The streamer services stay Manual; the agent starts them on Desktop/Open.
# agent.toml with [desktop] and the streamer port exclusions is rendered by sbx-tpl.
. (Join-Path $PSScriptRoot '..\lib.ps1')
. (Join-Path $SbxFilesDir 'desktop-install.ps1')
Install-SbxDesktop -ProgramRoot $env:ProgramFiles -AgentRoot (Join-Path $env:ProgramData 'sbx-agent') -WorkRoot (Join-Path $SbxWorkDir 'desktop') -FilesRoot $SbxFilesDir

# Edge is the browser of the Windows desktop: no first-run, sign-in, sync or default-browser prompts.
$edge = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
Set-RegValue $edge HideFirstRunExperience 1
Set-RegValue $edge BrowserSignin 0
Set-RegValue $edge SyncDisabled 1
Set-RegValue $edge DefaultBrowserSettingEnabled 0
Set-RegValue $edge PromotionalTabsEnabled 0
Set-RegValue $edge ShowRecommendationsEnabled 0

Write-BuildLog 'done'
