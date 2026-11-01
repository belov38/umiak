param([string]$Root,[string]$Files)
$ErrorActionPreference='Stop'
. (Join-Path $Files 'desktop-install.ps1')
$commands=[Collections.Generic.List[string]]::new()
$ops=@{
 Fetch={param($Pin,$Path) [IO.File]::WriteAllText($Path,'artifact')}
 Native={param($File,$Arguments) $commands.Add("$File $($Arguments -join ' ')")}.GetNewClosure()
 Expand={param($Path,$Directory) New-Item -ItemType Directory -Force $Directory | Out-Null; if($Path -like '*moonlight*'){New-Item -ItemType Directory -Force (Join-Path $Directory 'package') | Out-Null;[IO.File]::WriteAllText((Join-Path $Directory 'package/web-server.exe'),'fake')}else{[IO.File]::WriteAllText((Join-Path $Directory 'cua-driver.exe'),'fake')}}
 Link={param($Link,$Target) Copy-Item -LiteralPath $Target -Destination $Link -Recurse}
 Generate={param($Binary,$Config) [IO.File]::WriteAllText($Config,'{"web_server":{},"webrtc":{},"data_storage":{"type":"json"}}')}
}
$program=Join-Path $Root 'program';$agent=Join-Path $Root 'agent';$work=Join-Path $Root 'work'
New-Item -ItemType Directory -Force $agent | Out-Null
# The recipe files plus a fake patched moonlight-web build (moonlight-web/build.sh output).
$recipeFiles=Join-Path $Root 'files'
Copy-Item -LiteralPath $Files -Destination $recipeFiles -Recurse
$patched=Join-Path $recipeFiles 'moonlight-web'
New-Item -ItemType Directory -Force $patched | Out-Null
[IO.File]::WriteAllText((Join-Path $patched 'web-server.exe'),'patched')
$sha=(Get-FileHash -LiteralPath (Join-Path $patched 'web-server.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
@{patch='ping-order.patch';sha256=$sha} | ConvertTo-Json | Set-Content (Join-Path $patched 'build.json')
Install-SbxDesktop -ProgramRoot $program -AgentRoot $agent -WorkRoot $work -FilesRoot $recipeFiles -Ops $ops
$web=Join-Path $program 'sbx-desktop/moonlight-web/current'
if((Get-Content -Raw (Join-Path $web 'web-server.exe')) -ne 'patched' -or -not (Test-Path (Join-Path $web 'sbx-build.json'))){throw 'upstream moonlight-web server kept'}
[IO.File]::WriteAllText((Join-Path $patched 'web-server.exe'),'tampered')
$refusedPatch=$false
try{Install-SbxPatchedMoonlight $patched (Join-Path $Root 'patch-check')}catch{$refusedPatch=$_.Exception.Message -match 'SHA256 mismatch'}
if(-not $refusedPatch){throw 'tampered moonlight-web build accepted'}
$config=Get-Content -Raw (Join-Path $agent 'desktop/moonlight.json') | ConvertFrom-Json
if($config.web_server.bind_address -ne '127.0.0.1:47800' -or $config.webrtc.ice_servers.Count -ne 0){throw 'public/default STUN config'}
if(-not ($commands | Where-Object {$_ -match 'config SunshineService start= demand'})){throw 'Sunshine not manual'}
if(-not ($commands | Where-Object {$_ -match 'create sbx-moonlight-web'})){throw 'SCM wrapper missing'}
$bad=Join-Path $Root 'bad.bin'
$refused=$false
try{Get-SbxDesktopArtifact -Pin @{url='https://invalid.example/';sha256=('0'*64)} -Destination $bad -Download {param($Url,$Destination)[IO.File]::WriteAllText($Destination,'tampered')}}catch{$refused=$true}
if(-not $refused){throw 'corrupt asset accepted'}
Get-ChildItem $Files -Filter '*.ps1' | ForEach-Object {$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors | Out-String)}}
Write-Output 'desktop install fake PASS'
