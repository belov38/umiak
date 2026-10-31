@echo off
rem SetupComplete.cmd of every clone (spec S9 section 10.2). Windows Setup runs
rem it once as SYSTEM after OOBE, before the first logon. 90-cleanup installs
rem it to C:\Windows\Setup\Scripts\SetupComplete.cmd in place of the build one.
rem firstboot.ps1 restores what sysprep resets; neither ever fails Setup.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\sbx-template\firstboot.ps1"
exit /b 0
