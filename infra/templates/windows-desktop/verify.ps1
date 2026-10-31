# Desktop checks of a windows-desktop build (spec S10 sections 6.6, 7, 8). sbx-tpl splices this
# file into windows/verify.ps1 before its main block, so Report and Invoke-Capture are defined.
# API, screenshots and streamed media are checked by infra/dev-cp/e2e-desktop.sh.

$DesktopRoot = Join-Path $env:ProgramData 'sbx-agent\desktop'
$StreamerRoot = Join-Path $env:ProgramFiles 'sbx-desktop'
$StreamerPorts = @(47800, 47984, 47989, 47990, 48010)

function Test-Desktop {
    $sunshine = Join-Path $env:ProgramFiles 'Sunshine\sunshine.exe'
    Report desktop_sunshine (Test-Path -LiteralPath $sunshine -PathType Leaf) $sunshine
    foreach ($p in @(
            @('desktop_moonlight', (Join-Path $StreamerRoot 'moonlight-web\current\web-server.exe')),
            @('desktop_cua', (Join-Path $StreamerRoot 'cua-driver\current\cua-driver.exe')))) {
        Report $p[0] (Test-Path -LiteralPath $p[1] -PathType Leaf) $p[1]
    }

    # Both streamer services exist, start on demand only and are stopped on a fresh clone.
    $bad = [Collections.Generic.List[string]]::new()
    foreach ($name in @('SunshineService', 'sbx-moonlight-web')) {
        $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
        if ($null -eq $svc) { $bad.Add("$name absent"); continue }
        if ($svc.StartMode -ne 'Manual' -or $svc.State -ne 'Stopped') { $bad.Add("$name $($svc.State)/$($svc.StartMode)") }
        if ($name -eq 'sbx-moonlight-web' -and $svc.StartName -ne 'NT SERVICE\sbx-moonlight-web') { $bad.Add("$name runs as $($svc.StartName)") }
    }
    Report desktop_services ($bad.Count -eq 0) $(if ($bad.Count) { $bad -join ', ' } else { 'SunshineService, sbx-moonlight-web: Manual, Stopped' })

    # moonlight-web template: loopback only, no default STUN, ICE from the agent's file.
    $cfgFile = Join-Path $DesktopRoot 'moonlight.json'
    $ok = $false
    $ev = "$cfgFile missing"
    if (Test-Path -LiteralPath $cfgFile) {
        $cfg = Get-Content -Raw -LiteralPath $cfgFile | ConvertFrom-Json
        $ok = $cfg.web_server.bind_address -eq '127.0.0.1:47800' -and
            @($cfg.webrtc.ice_servers).Count -eq 0 -and
            $cfg.webrtc.ice_server_script -eq (Join-Path $DesktopRoot 'ice-servers.cmd') -and
            $cfg.web_server.forwarded_header.username_header -eq 'X-Sbx-Desktop-User'
        $ev = "bind $($cfg.web_server.bind_address), ice_servers $(@($cfg.webrtc.ice_servers).Count), script $($cfg.webrtc.ice_server_script)"
    }
    Report desktop_moonlight_config $ok $ev
    foreach ($f in @('ice-servers.cmd', 'register-session.ps1', 'run-cua.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $DesktopRoot $f))) { $ok = $false; $ev = "$f missing" }
    }
    Report desktop_files $ok $ev

    # agent.toml: desktop enabled, desktop readiness, streamer ports never published.
    $toml = Get-Content -Raw -LiteralPath (Join-Path $env:ProgramData 'sbx-agent\agent.toml')
    $missing = @($StreamerPorts | Where-Object { $toml -notmatch "exclude = \[[^\]]*\b$_\b" })
    $ok = $toml -match '(?m)^\[desktop\]\s*\r?\nenabled = true' -and
        $toml -match '(?m)^required = \[[^\]]*"desktop"' -and $missing.Count -eq 0
    Report desktop_agent_config $ok "missing excluded ports: $(if ($missing.Count) { $missing -join ', ' } else { 'none' })"

    # Nothing listens on the streamer ports until Desktop/Open, and never off loopback.
    $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $StreamerPorts })
    Report desktop_streamer_stopped ($listen.Count -eq 0) $(if ($listen.Count) { ($listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', ' } else { 'no listener' })

    # Edge first-run and sign-in prompts are off (spec S10 section 7).
    $edge = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' -ErrorAction SilentlyContinue
    $ok = $null -ne $edge -and $edge.HideFirstRunExperience -eq 1 -and $edge.BrowserSignin -eq 0 -and $edge.SyncDisabled -eq 1
    Report desktop_edge_policy $ok $(if ($edge) { "HideFirstRunExperience $($edge.HideFirstRunExperience), BrowserSignin $($edge.BrowserSignin), SyncDisabled $($edge.SyncDisabled)" } else { 'no Edge policy key' })
}

$SbxExtraGroups = [ordered]@{ desktop = { Test-Desktop } }
