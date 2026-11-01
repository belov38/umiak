#requires -Version 7
# 30-toolchains (spec S9 section 8.5): Git for Windows, Node, Python, uv, Bun,
# Go, gh from the official installers of versions.json, each checked against
# its pinned sha256. Every command is found by name in the system Path; the
# version probes run through Invoke-Probe (stdin closed, 120 s limit).
. (Join-Path $PSScriptRoot '..\lib.ps1')

if ((Get-BuildVersionInfo).options.vsBuildtools) {
    throw 'options.vs_buildtools is not supported by this image yet'
}

# --- Git for Windows (+ Git Bash for Claude Code) ---
$v = Get-ToolVersion 'git'
if ((Get-InstalledVersion 'git' @('--version')) -ne "git version $v") {
    $exe = Get-ToolFile -Name 'git'
    $log = Join-Path $UmiakLogDir 'git-install.log'
    Invoke-Installer -FilePath $exe -Arguments "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL /SP- /ALLUSERS /LOG=`"$log`" /o:PathOption=Cmd /o:EnableSymlinks=Enabled /o:CRLFOption=CRLFCommitAsIs"
}
$git = Assert-Command 'git'
Invoke-Native -FilePath $git -ArgumentList @('config', '--system', 'core.autocrlf', 'false')
Invoke-Native -FilePath $git -ArgumentList @('config', '--system', 'core.symlinks', 'true')
$gitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $gitBash)) { throw "$gitBash is missing" }
Set-MachineEnv CLAUDE_CODE_GIT_BASH_PATH $gitBash

# --- Node LTS (+ npm, npx); global npm prefix outside any profile ---
$v = Get-ToolVersion 'node'
if ((Get-InstalledVersion 'node' @('--version')) -ne "v$v") {
    Invoke-Msi -Path (Get-ToolFile -Name 'node')
}
$nodeDir = Join-Path $env:ProgramFiles 'nodejs'
$npmPrefix = Join-Path $env:ProgramData 'npm'
New-Item -ItemType Directory -Force -Path $npmPrefix | Out-Null
# Only SYSTEM and Administrators write into a directory of the system Path.
Invoke-Native -FilePath icacls.exe -ArgumentList @($npmPrefix, '/inheritance:r', '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F', '/grant', '*S-1-5-32-545:(OI)(CI)RX')
# The builtin npmrc of the npm package holds the Windows default prefix (%APPDATA%\npm).
$npmrc = Join-Path $nodeDir 'node_modules\npm\npmrc'
[IO.File]::WriteAllText($npmrc, "prefix=$npmPrefix`nupdate-notifier=false`nfund=false`n", [Text.UTF8Encoding]::new($false))
Add-MachinePath $npmPrefix
Assert-Command 'node' | Out-Null
$npm = Assert-Command 'npm.cmd'
$r = Invoke-Probe -FilePath $npm -ArgumentList @('prefix', '-g')
if ($r.ExitCode -ne 0) { throw "npm prefix -g: exit code $($r.ExitCode): $($r.Errors -join ' | ')" }
$prefix = "$($r.Output | Select-Object -Last 1)".Trim()
if ($prefix -ne $npmPrefix) { throw "npm prefix -g is '$prefix', want $npmPrefix" }

# --- Python 3 (all users, py launcher) ---
$v = Get-ToolVersion 'python'
if ((Get-InstalledVersion 'python' @('--version')) -ne "Python $v") {
    $log = Join-Path $UmiakLogDir 'python-install.log'
    Invoke-Installer -FilePath (Get-ToolFile -Name 'python') -Arguments "/quiet /log `"$log`" InstallAllUsers=1 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=1 Include_test=0 Shortcuts=0"
}
Assert-Command 'python' | Out-Null
Assert-Command 'py' | Out-Null

# --- uv, uvx: zip into Program Files ---
$v = Get-ToolVersion 'uv'
$uvDir = Join-Path $env:ProgramFiles 'uv'
if ((Get-InstalledVersion 'uv' @('--version')) -notlike "uv $v*") {
    $src = Expand-ToWorkDir (Get-ToolFile -Name 'uv') 'uv'
    New-Item -ItemType Directory -Force -Path $uvDir | Out-Null
    foreach ($exe in Get-ChildItem -LiteralPath $src -Recurse -Filter '*.exe') {
        Copy-Item -LiteralPath $exe.FullName -Destination $uvDir -Force
    }
}
Add-MachinePath $uvDir
Assert-Command 'uv' | Out-Null
Assert-Command 'uvx' | Out-Null

# --- Bun: zip into Program Files ---
$v = Get-ToolVersion 'bun'
$bunDir = Join-Path $env:ProgramFiles 'bun'
if ((Get-InstalledVersion 'bun' @('--version')) -ne $v) {
    $src = Expand-ToWorkDir (Get-ToolFile -Name 'bun') 'bun'
    $bunExe = Get-ChildItem -LiteralPath $src -Recurse -Filter 'bun.exe' | Select-Object -First 1
    if ($null -eq $bunExe) { throw 'bun.exe is not in the bun archive' }
    New-Item -ItemType Directory -Force -Path $bunDir | Out-Null
    Copy-Item -LiteralPath $bunExe.FullName -Destination $bunDir -Force
}
Add-MachinePath $bunDir
Assert-Command 'bun' | Out-Null

# --- Go ---
$v = Get-ToolVersion 'go'
if ((Get-InstalledVersion 'go' @('version')) -notlike "go version go$v *") {
    Invoke-Msi -Path (Get-ToolFile -Name 'go')
}
Assert-Command 'go' | Out-Null

# --- gh ---
$v = Get-ToolVersion 'gh'
if ((Get-InstalledVersion 'gh' @('--version')) -notlike "gh version $v *") {
    Invoke-Msi -Path (Get-ToolFile -Name 'gh')
}
Assert-Command 'gh' | Out-Null

# The installed versions, for the build log.
foreach ($t in @(@('git', '--version'), @('node', '--version'), @('npm.cmd', '--version'), @('python', '--version'),
        @('py', '--version'), @('uv', '--version'), @('bun', '--version'), @('go', 'version'), @('gh', '--version'))) {
    Write-BuildLog "$($t[0]): $(Get-InstalledVersion $t[0] @($t[1]))"
}
Write-BuildLog 'done'
