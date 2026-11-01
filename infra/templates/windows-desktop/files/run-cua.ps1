$ErrorActionPreference='Stop'
# Keep the optional in-VM driver out of the visible desktop.
$binary=Join-Path $env:ProgramFiles 'umiak-desktop\cua-driver\current\cua-driver.exe'
$start=[Diagnostics.ProcessStartInfo]::new($binary)
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.ArgumentList.Add('serve')
$process=[Diagnostics.Process]::Start($start)
try{$process.WaitForExit();exit $process.ExitCode}finally{$process.Dispose()}
