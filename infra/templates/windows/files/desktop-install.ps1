# S10 installer library. OS/network operations can be replaced by fake boundaries.
Set-StrictMode -Version Latest
function Get-SbxDesktopArtifact {
    param($Pin,[string]$Destination,[scriptblock]$Download={param($Url,$Destination) Invoke-WebRequest -Uri $Url -OutFile $Destination})
    & $Download $Pin.url $Destination
    $hash=(Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if($hash -ne $Pin.sha256){throw 'desktop artifact SHA256 mismatch'}
}
function Invoke-SbxDesktopNative {
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
function Install-SbxDesktop {
    param([string]$ProgramRoot,[string]$AgentRoot,[string]$WorkRoot,[string]$FilesRoot,[hashtable]$Ops=@{})
    $defaults=@{
        Fetch={param($Pin,$Path) Get-SbxDesktopArtifact $Pin $Path}
        Native={param($File,$Arguments) Invoke-SbxDesktopNative $File $Arguments}
        Expand={param($Path,$Directory) Expand-Archive -LiteralPath $Path -DestinationPath $Directory -Force}
        Link={param($Link,$Target) New-Item -ItemType Junction -Path $Link -Target $Target -Force | Out-Null}
        Generate={param($Binary,$Config) Invoke-SbxDesktopNative $Binary @('--config-path',$Config,'config','generate')}
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
        $parent=Join-Path (Join-Path $ProgramRoot 'sbx-desktop') $folder
        $versionDir=Join-Path $parent $pins.$key.version
        $unpack=Join-Path $WorkRoot "$key-unpack"
        & $Ops.Expand (Join-Path $WorkRoot $assets[$key]) $unpack
        $source=if($key -eq 'moonlight'){Join-Path $unpack 'package'}else{$unpack}
        New-Item -ItemType Directory -Force $parent | Out-Null
        Copy-Item -LiteralPath $source -Destination $versionDir -Recurse -Force
        $binary=Join-Path $versionDir $(if($key -eq 'moonlight'){'web-server.exe'}else{'cua-driver.exe'})
        if(-not (Test-Path -LiteralPath $binary)){throw "desktop archive missing executable: $key"}
        & $Ops.Link (Join-Path $parent 'current') $versionDir
    }
    $bundle=Join-Path $WorkRoot 'cua.sigstore.json'
    $signature=@{url=($pins.cua.url+'.sigstore.json');sha256='da18eb92cfaba790609a6abee97e425541b96775f030d87b8cf6835bae516b13'}
    & $Ops.Fetch $signature $bundle
    & $Ops.Native (Join-Path $WorkRoot 'cosign.exe') @('verify-blob','--bundle',$bundle,'--certificate-identity',"https://github.com/trycua/cua/.github/workflows/cd-rust-cua-driver.yml@refs/tags/cua-driver-rs-v$($pins.cua.version)",'--certificate-oidc-issuer','https://token.actions.githubusercontent.com',(Join-Path $WorkRoot 'cua.zip'))
    $desktop=Join-Path $AgentRoot 'desktop'
    New-Item -ItemType Directory -Force $desktop | Out-Null
    $config=Join-Path $desktop 'moonlight.json'
    $web=Join-Path (Join-Path $ProgramRoot 'sbx-desktop') 'moonlight-web/current/web-server.exe'
    & $Ops.Generate $web $config
    $settings=Get-Content -Raw $config | ConvertFrom-Json -AsHashtable
    $settings.web_server['bind_address']='127.0.0.1:47800'
    $settings.web_server['first_login_create_admin']=$true
    $settings.web_server['first_login_assign_global_hosts']=$false
    $settings.web_server['forwarded_header']=@{username_header='X-Sbx-Desktop-User';auto_create_missing_user=$false}
    $settings.webrtc['ice_servers']=@()
    $settings.webrtc['ice_server_script']=Join-Path $desktop 'ice-servers.cmd'
    [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 30))
    Copy-Item -LiteralPath (Join-Path $FilesRoot 'register-session.ps1') -Destination $desktop -Force
    Copy-Item -LiteralPath (Join-Path $FilesRoot 'run-cua.ps1') -Destination $desktop -Force
    $ice=Join-Path (Join-Path $AgentRoot 'state') 'desktop-moonlight/ice-servers.json'
    [IO.File]::WriteAllText((Join-Path $desktop 'ice-servers.cmd'),"@echo off`r`ntype `"$ice`"`r`n")
    $agent=Join-Path $ProgramRoot 'sbx-agent/current/sbx-agent.exe'
    & $Ops.Native 'sc.exe' @('create','sbx-moonlight-web','binPath=',("`"$agent`" stream-web"),'start=','demand','obj=','NT SERVICE\sbx-moonlight-web')
    & $Ops.Native 'sc.exe' @('config','sbx-moonlight-web','binPath=',("`"$agent`" stream-web"),'start=','demand','obj=','NT SERVICE\sbx-moonlight-web')
    & $Ops.Native 'sc.exe' @('sidtype','sbx-moonlight-web','unrestricted')
    & $Ops.Native 'sc.exe' @('failure','sbx-moonlight-web','reset=','86400','actions=','restart/15000/restart/30000/restart/60000')
    $toml=Join-Path $AgentRoot 'agent.toml';$text=Get-Content -Raw $toml
    if($text -notmatch '(?m)^required\s*='){throw 'missing readiness configuration'}
    $text=[regex]::Replace($text,'(?m)^required\s*=\s*\[([^\r\n]*)\]',{param($m) if($m.Value.Contains('desktop')){$m.Value}else{'required = ['+$m.Groups[1].Value+', "desktop"]'}})
    $text=[regex]::Replace($text,'(?ms)^\[(desktop|ports)\]\r?\n.*?(?=^\[|\z)','')
    $text+="`n[desktop]`nenabled = true`n[ports]`nexclude = [22, 53, 47800, 47984, 47989, 47990, 48010]`n"
    [IO.File]::WriteAllText($toml,$text)
    & $Ops.Native 'icacls.exe' @($desktop,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F','NT SERVICE\sbx-moonlight-web:(OI)(CI)RX','/T','/Q')
}
