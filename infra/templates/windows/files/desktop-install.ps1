# Sigstore certificate issuer verification below protects the downloaded guest tool; it is not platform authentication.
# S10 installer library. OS/network operations can be replaced by fake boundaries.
Set-StrictMode -Version Latest
function Get-UmiakDesktopArtifact {
    param($Pin,[string]$Destination,[scriptblock]$Download={param($Url,$Destination) Invoke-WebRequest -Uri $Url -OutFile $Destination})
    & $Download $Pin.url $Destination
    $hash=(Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -ne $Pin.sha256){throw 'desktop artifact SHA256 mismatch'}
}
function Invoke-UmiakDesktopNative {
    param([string]$File,[string[]]$Arguments)
    $start=[Diagnostics.ProcessStartInfo]::new($File)
    $start.UseShellExecute=$false
    foreach($argument in $Arguments){$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::Start($start)
    try{
        $process.WaitForExit();$allowed=@(0,3010)
        if([IO.Path]::GetFileName($File) -eq 'sc.exe' -and $Arguments[0] -eq 'stop'){$allowed+=1062}
        if([IO.Path]::GetFileName($File) -eq 'sc.exe' -and $Arguments[0] -eq 'create'){$allowed+=1073}
        if($process.ExitCode -notin $allowed){throw "desktop installer command failed: $File, exit $($process.ExitCode)"}
    }finally{$process.Dispose()}
}
# Upstream web-server.exe can stream no video at all on Windows: Sunshine may take its
# audio socket for the video address (S10 spec 8.6). The recipe ships a build of the same
# release with moonlight-web/ping-order.patch (moonlight-web/build.sh); only the server
# binary of the pinned zip is replaced.
function Install-UmiakPatchedMoonlight {
    param([string]$Source,[string]$VersionDir)
    $exe=Join-Path $Source 'web-server.exe';$build=Join-Path $Source 'build.json'
    if(-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $build)){throw 'patched moonlight-web missing: run infra/templates/windows/moonlight-web/build.sh'}
    $info=Get-Content -Raw -LiteralPath $build | ConvertFrom-Json
    if((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $info.sha256){throw 'patched moonlight-web SHA256 mismatch'}
    Copy-Item -LiteralPath $exe -Destination (Join-Path $VersionDir 'web-server.exe') -Force
    Copy-Item -LiteralPath $build -Destination (Join-Path $VersionDir 'umiak-build.json') -Force
}
function Install-UmiakDesktop {
    param([string]$ProgramRoot,[string]$AgentRoot,[string]$WorkRoot,[string]$FilesRoot,[hashtable]$Ops=@{})
    $defaults=@{
        Fetch={param($Pin,$Path) Get-UmiakDesktopArtifact $Pin $Path}
        Native={param($File,$Arguments) Invoke-UmiakDesktopNative $File $Arguments}
        Expand={param($Path,$Directory) Expand-Archive -LiteralPath $Path -DestinationPath $Directory -Force}
        Link={param($Link,$Target) New-Item -ItemType Junction -Path $Link -Target $Target -Force | Out-Null}
        Generate={param($Binary,$Config) Invoke-UmiakDesktopNative $Binary @('--config-path',$Config,'config','generate')}
    }
    foreach($key in $defaults.Keys){if(-not $Ops.ContainsKey($key)){$Ops[$key]=$defaults[$key]}}
    $pins=Get-Content -Raw (Join-Path $FilesRoot 'desktop-pins.json') | ConvertFrom-Json
    New-Item -ItemType Directory -Force $WorkRoot | Out-Null
    $assets=@{sun='sunshine.msi';moonlight='moonlight.zip';cua='cua.zip';cosign='cosign.exe'}
    foreach($key in $assets.Keys){& $Ops.Fetch $pins.$key (Join-Path $WorkRoot $assets[$key])}
    & $Ops.Native 'msiexec.exe' @('/i',(Join-Path $WorkRoot 'sunshine.msi'),'/qn','/norestart')
    & $Ops.Native 'sc.exe' @('stop','SunshineService')
    & $Ops.Native 'sc.exe' @('config','SunshineService','start=','demand')
    foreach($key in @('moonlight','cua')){
        $folder=if($key -eq 'moonlight'){'moonlight-web'}else{'cua-driver'}
        $parent=Join-Path (Join-Path $ProgramRoot 'umiak-desktop') $folder
        $versionDir=Join-Path $parent $pins.$key.version
        $unpack=Join-Path $WorkRoot "$key-unpack"
        & $Ops.Expand (Join-Path $WorkRoot $assets[$key]) $unpack
        $source=if($key -eq 'moonlight'){Join-Path $unpack 'package'}else{$unpack}
        New-Item -ItemType Directory -Force $parent | Out-Null
        Copy-Item -LiteralPath $source -Destination $versionDir -Recurse -Force
        $binary=Join-Path $versionDir $(if($key -eq 'moonlight'){'web-server.exe'}else{'cua-driver.exe'})
        if(-not (Test-Path -LiteralPath $binary)){throw "desktop archive missing executable: $key"}
        if($key -eq 'moonlight'){Install-UmiakPatchedMoonlight (Join-Path $FilesRoot 'moonlight-web') $versionDir}
        & $Ops.Link (Join-Path $parent 'current') $versionDir
    }
    $bundle=Join-Path $WorkRoot 'cua.sigstore.json'
    $signature=@{url=($pins.cua.url+'.sigstore.json');sha256='da18eb92cfaba790609a6abee97e425541b96775f030d87b8cf6835bae516b13'}
    & $Ops.Fetch $signature $bundle
    & $Ops.Native (Join-Path $WorkRoot 'cosign.exe') @('verify-blob','--bundle',$bundle,'--certificate-identity',"https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v$($pins.cua.version)",'--certificate-oidc-issuer','https://token.actions.githubusercontent.com',(Join-Path $WorkRoot 'cua.zip'))
    # The service account must exist before the directory ACL names it.
    $agent=Join-Path $ProgramRoot 'umiak-agent/current/umiak-agent.exe'
    & $Ops.Native 'sc.exe' @('create','umiak-moonlight-web','binPath=',("`"$agent`" stream-web"),'start=','demand','obj=','NT SERVICE\umiak-moonlight-web')
    & $Ops.Native 'sc.exe' @('config','umiak-moonlight-web','binPath=',("`"$agent`" stream-web"),'start=','demand','obj=','NT SERVICE\umiak-moonlight-web')
    & $Ops.Native 'sc.exe' @('sidtype','umiak-moonlight-web','unrestricted')
    & $Ops.Native 'sc.exe' @('failure','umiak-moonlight-web','reset=','86400','actions=','restart/15000/restart/30000/restart/60000')
    $desktop=Join-Path $AgentRoot 'desktop'
    New-Item -ItemType Directory -Force $desktop | Out-Null
    # Directory ACL first; every file below only inherits it (no per-file grants).
    & $Ops.Native 'icacls.exe' @($desktop,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F','NT SERVICE\umiak-moonlight-web:(OI)(CI)RX','/Q')
    $config=Join-Path $desktop 'moonlight.json'
    $web=Join-Path (Join-Path $ProgramRoot 'umiak-desktop') 'moonlight-web/current/web-server.exe'
    & $Ops.Generate $web $config
    $settings=Get-Content -Raw $config | ConvertFrom-Json -AsHashtable
    $settings.web_server['bind_address']='127.0.0.1:47800'
    $settings.web_server['first_login_create_admin']=$true
    $settings.web_server['first_login_assign_global_hosts']=$false
    $settings.web_server['forwarded_header']=@{username_header='X-Umiak-Desktop-User';auto_create_missing_user=$false}
    $settings.webrtc['ice_servers']=@()
    $settings.webrtc['ice_server_script']=Join-Path $desktop 'ice-servers.cmd'
    [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 30))
    Copy-Item -LiteralPath (Join-Path $FilesRoot 'register-session.ps1') -Destination $desktop -Force
    Copy-Item -LiteralPath (Join-Path $FilesRoot 'run-cua.ps1') -Destination $desktop -Force
    $ice=Join-Path (Join-Path $AgentRoot 'state') 'desktop-moonlight/ice-servers.json'
    [IO.File]::WriteAllText((Join-Path $desktop 'ice-servers.cmd'),"@echo off`r`ntype `"$ice`"`r`n")
    & $Ops.Native 'icacls.exe' @((Join-Path $desktop '*'),'/reset','/T','/Q')
}
