@echo off
rem Computer startup script of the local GPO (installed by 50-sbx-agent).
rem Runs `sbx-agent early` from current\, else previous\, else the newest
rem versions\*\: a missing "current" junction (an interrupted update) must not
rem leave the machine without its boot step.
setlocal EnableExtensions
set "SBX_DIR=%~dp0"
set "SBX_EXE="
if exist "%SBX_DIR%current\sbx-agent.exe" set "SBX_EXE=%SBX_DIR%current\sbx-agent.exe"
if not defined SBX_EXE if exist "%SBX_DIR%previous\sbx-agent.exe" set "SBX_EXE=%SBX_DIR%previous\sbx-agent.exe"
if not defined SBX_EXE for /f "delims=" %%V in ('dir /b /ad /o-d "%SBX_DIR%versions" 2^>nul') do if not defined SBX_EXE if exist "%SBX_DIR%versions\%%V\sbx-agent.exe" set "SBX_EXE=%SBX_DIR%versions\%%V\sbx-agent.exe"
if not defined SBX_EXE (
    echo sbx-early: no sbx-agent.exe under %SBX_DIR% 1>&2
    exit /b 1
)
"%SBX_EXE%" early
exit /b %errorlevel%
