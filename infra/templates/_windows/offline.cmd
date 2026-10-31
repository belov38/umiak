@echo off
rem Offline WinPE stage (spec S9 section 10.3): sets Start=4 for services in
rem the offline SYSTEM hive of the installed Windows, then powers the VM off.
rem It runs before sysprep, in WinPE of the Windows ISO that sbx-tpl boots once
rem from a ramdisk BCD entry of the installed, not yet sealed Windows.
rem WinPE of Windows Setup has no PowerShell: cmd, reg, drvload, diskpart only.
rem offline-config.cmd (written by sbx-tpl) sets SBX_DRIVERS and SBX_SERVICES.
rem Log lines: OK / MISSING / ERROR <key>, last line "DONE errors <n>".
rem The script always ends with wpeutil shutdown, so Setup never continues. The
rem log is copied to the Windows volume when one was found; sbx-tpl boots that
rem disk next (verify-offline), reads the log and the services, and fails the
rem build on errors before sysprep.
setlocal EnableExtensions
set "SRC=%~d0"
set "LOG=X:\sbx-offline.log"
set ERRORS=0
set SETS=0
call "%SRC%\offline-config.cmd"
> "%LOG%" echo sbx offline stage: drivers %SBX_DRIVERS%, services %SBX_SERVICES%

rem The setup WinPE has no virtio-scsi driver; DriverPaths of an answer file
rem apply only to the installation itself.
call :find_virtio
if not defined VIRTIO goto no_virtio
call :log drvload %VIRTIO%\vioscsi\%SBX_DRIVERS%\amd64\vioscsi.inf
drvload "%VIRTIO%\vioscsi\%SBX_DRIVERS%\amd64\vioscsi.inf" >> "%LOG%" 2>&1
if errorlevel 1 call :log ERROR drvload exit code %ERRORLEVEL%

rem Volumes of the new disk get letters a moment after drvload.
set TRIES=0
:wait_windows
call :find_windows
if defined WIN goto found
set /a TRIES+=1
if %TRIES% EQU 5 call :assign_letter
if %TRIES% GEQ 15 goto no_windows
ping -n 3 127.0.0.1 >nul
goto wait_windows

:found
call :log Windows volume %WIN%
reg load HKLM\OFFSYS "%WIN%\Windows\System32\config\SYSTEM" >> "%LOG%" 2>&1
if errorlevel 1 goto no_hive
for %%n in (001 002 003 004 005 006 007 008 009) do (
  reg query HKLM\OFFSYS\ControlSet%%n >nul 2>&1 && call :control_set HKLM\OFFSYS\ControlSet%%n
)
if %SETS% EQU 0 (
  set /a ERRORS+=1
  call :log ERROR no ControlSet00x in the offline hive
)
reg unload HKLM\OFFSYS >> "%LOG%" 2>&1
if errorlevel 1 (
  set /a ERRORS+=1
  call :log ERROR reg unload failed
)

:finish
call :log DONE errors %ERRORS%
if not defined WIN goto shutdown
if not exist "%WIN%\Windows\Setup\Scripts" mkdir "%WIN%\Windows\Setup\Scripts"
copy /y "%LOG%" "%WIN%\Windows\Setup\Scripts\sbx-offline.log" >nul
if errorlevel 1 echo ERROR copy of the log to %WIN% failed

:shutdown
wpeutil shutdown
exit /b 0

:control_set
set "CS=%~1"
set /a SETS+=1
for %%s in (%SBX_SERVICES%) do call :disable %%s
exit /b 0

:disable
reg query "%CS%\Services\%~1" >nul 2>&1
if errorlevel 1 (
  call :log MISSING %CS%\Services\%~1
  exit /b 0
)
reg add "%CS%\Services\%~1" /v Start /t REG_DWORD /d 4 /f >nul 2>&1
if errorlevel 1 (
  set /a ERRORS+=1
  call :log ERROR %CS%\Services\%~1 Start 4 not set
  exit /b 0
)
call :log OK %CS%\Services\%~1 Start 4
exit /b 0

:find_virtio
set VIRTIO=
for %%d in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do if not defined VIRTIO if exist "%%d:\vioscsi\%SBX_DRIVERS%\amd64\vioscsi.inf" set "VIRTIO=%%d:"
exit /b 0

:find_windows
rem The WinPE system drive has its own config\SYSTEM and is left out.
set WIN=
for %%d in (C D E F G H I J K L M N O P Q R S T U V W Y Z) do if not defined WIN if exist "%%d:\Windows\System32\config\SYSTEM" set "WIN=%%d:"
exit /b 0

:assign_letter
rem No letter from automount: the build put Windows on partition 3 of disk 0.
rem A disk that WinPE sees as offline or read-only is brought online first.
call :log assigning W: to disk 0 partition 3
> X:\sbx-diskpart.txt echo select disk 0
>> X:\sbx-diskpart.txt echo rescan
>> X:\sbx-diskpart.txt echo online disk noerr
>> X:\sbx-diskpart.txt echo attributes disk clear readonly noerr
>> X:\sbx-diskpart.txt echo select partition 3
>> X:\sbx-diskpart.txt echo assign letter=W noerr
diskpart /s X:\sbx-diskpart.txt >> "%LOG%" 2>&1
exit /b 0

:log
>> "%LOG%" echo %*
echo %*
exit /b 0

:no_virtio
set /a ERRORS+=1
call :log ERROR no drive with vioscsi\%SBX_DRIVERS%\amd64\vioscsi.inf
rem Without the disk driver no Windows volume shows up: nowhere to copy the log.
set WIN=
goto finish

:no_windows
set /a ERRORS+=1
call :log ERROR no volume with Windows\System32\config\SYSTEM
goto finish

:no_hive
set /a ERRORS+=1
call :log ERROR reg load of the offline SYSTEM hive failed
goto finish
