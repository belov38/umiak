@echo off
rem Offline WinPE stage (spec S9 section 10.3): sets Start=4 for services in
rem the offline SYSTEM hive of the sealed Windows, then powers the VM off.
rem WinPE of Windows Setup has no PowerShell: cmd, reg, drvload, diskpart only.
rem offline-config.cmd (written by sbx-tpl) sets SBX_DRIVERS and SBX_SERVICES.
rem Log lines: OK / MISSING / ERROR <key>, last line "DONE errors <n>".
rem Any error: the script hangs, Setup never continues, the builder times out.
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
if not exist "%WIN%\Windows\Setup\Scripts" mkdir "%WIN%\Windows\Setup\Scripts"
call :log DONE errors %ERRORS%
copy /y "%LOG%" "%WIN%\Windows\Setup\Scripts\sbx-offline.log" >nul
if errorlevel 1 goto hang
if not %ERRORS% EQU 0 goto hang
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
call :log assigning W: to disk 0 partition 3
> X:\sbx-diskpart.txt echo select disk 0
>> X:\sbx-diskpart.txt echo select partition 3
>> X:\sbx-diskpart.txt echo assign letter=W noerr
diskpart /s X:\sbx-diskpart.txt >> "%LOG%" 2>&1
exit /b 0

:log
>> "%LOG%" echo %*
echo %*
exit /b 0

:no_virtio
call :log ERROR no drive with vioscsi\%SBX_DRIVERS%\amd64\vioscsi.inf
goto hang

:no_windows
call :log ERROR no volume with Windows\System32\config\SYSTEM
goto hang

:no_hive
call :log ERROR reg load of the offline SYSTEM hive failed
goto hang

:hang
rem Setup must not continue to its UI: wait here until the builder gives up.
ping -n 60 127.0.0.1 >nul
goto hang
