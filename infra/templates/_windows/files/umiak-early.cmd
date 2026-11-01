@echo off
rem Computer startup script of the local GPO (installed by 50-umiak-agent).
rem Runs `umiak-agent early` from current\, else previous\, else the newest
rem versions\*\: a missing "current" junction (an interrupted update) must not
rem leave the machine without its boot step.
setlocal EnableExtensions
set "UMIAK_DIR=%~dp0"
set "UMIAK_EXE="
if exist "%UMIAK_DIR%current\umiak-agent.exe" set "UMIAK_EXE=%UMIAK_DIR%current\umiak-agent.exe"
if not defined UMIAK_EXE if exist "%UMIAK_DIR%previous\umiak-agent.exe" set "UMIAK_EXE=%UMIAK_DIR%previous\umiak-agent.exe"
if not defined UMIAK_EXE for /f "delims=" %%V in ('dir /b /ad /o-d "%UMIAK_DIR%versions" 2^>nul') do if not defined UMIAK_EXE if exist "%UMIAK_DIR%versions\%%V\umiak-agent.exe" set "UMIAK_EXE=%UMIAK_DIR%versions\%%V\umiak-agent.exe"
if not defined UMIAK_EXE (
    echo umiak-early: no umiak-agent.exe under %UMIAK_DIR% 1>&2
    exit /b 1
)
"%UMIAK_EXE%" early
exit /b %errorlevel%
