@echo off
rem Runs once as SYSTEM at the end of the build install, before the first logon
rem (spec S9 section 7 p.4). Installs the virtio guest tools (drivers, balloon,
rem VSS provider) and the QEMU guest agent from the virtio-win ISO; the builder
rem waits for QGA. Specialize copied this file from the build ISO.
setlocal EnableExtensions
set "LOGS=C:\umiak-build\logs"
if not exist "%LOGS%" mkdir "%LOGS%"
set "LOG=%LOGS%\setupcomplete.log"
>> "%LOG%" echo %DATE% %TIME% SetupComplete start

set VIRTIO=
for %%d in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do if not defined VIRTIO if exist "%%d:\virtio-win-gt-x64.msi" if exist "%%d:\guest-agent\qemu-ga-x86_64.msi" set "VIRTIO=%%d:"
if not defined VIRTIO goto no_virtio
>> "%LOG%" echo virtio-win drive %VIRTIO%

start "" /wait msiexec.exe /i "%VIRTIO%\virtio-win-gt-x64.msi" /qn /norestart /l*v "%LOGS%\virtio-win-gt-x64.msi.log"
call :result virtio-win-gt-x64.msi %ERRORLEVEL%
start "" /wait msiexec.exe /i "%VIRTIO%\guest-agent\qemu-ga-x86_64.msi" /qn /norestart /l*v "%LOGS%\qemu-ga-x86_64.msi.log"
call :result qemu-ga-x86_64.msi %ERRORLEVEL%

>> "%LOG%" echo %DATE% %TIME% SetupComplete done
exit /b 0

:result
rem 3010 is success with a reboot pending; the builder reboots after 00-base.
if "%~2"=="0" goto result_ok
if "%~2"=="3010" goto result_ok
>> "%LOG%" echo ERROR %~1 exit code %~2
exit /b 0
:result_ok
>> "%LOG%" echo OK %~1 exit code %~2
exit /b 0

:no_virtio
>> "%LOG%" echo ERROR no drive with virtio-win-gt-x64.msi and guest-agent\qemu-ga-x86_64.msi
exit /b 1
