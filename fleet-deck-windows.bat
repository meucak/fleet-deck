@echo off
set URL=http://fleetdeck.com
where msedge >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" msedge --app=%URL%
    exit /b 0
)
where chrome >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    start "" chrome --app=%URL%
    exit /b 0
)
start "" %URL%
