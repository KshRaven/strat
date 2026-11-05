@echo off
REM Double-click on Windows: installs dependencies if needed and opens the control panel.
cd /d "%~dp0"
where bun >nul 2>nul
if errorlevel 1 (
  echo Bun is not installed. Install it from https://bun.sh then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  bun install
)
start "" http://localhost:3000
bun launcher.js
pause
