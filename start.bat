@echo off
setlocal
REM One launcher: Python venv + deps, data check, Python backend + index.html and, if Bun exists, the original panel.
REM Admin rights are NOT needed. Only installing Python/Bun themselves can prompt UAC (winget does that itself).
cd /d "%~dp0"

set PY=
where py >nul 2>nul && set PY=py -3
if "%PY%"=="" (where python >nul 2>nul && set PY=python)
if "%PY%"=="" (
  echo Python 3 not found.
  where winget >nul 2>nul
  if not errorlevel 1 (
    echo Installing Python 3.12 with winget ^(Windows may ask for permission^)...
    winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    echo Python installed. Close this window and run start.bat again so PATH refreshes.
  ) else (
    echo Install Python 3.11 or 3.12 from https://www.python.org then run this again.
  )
  pause
  exit /b 1
)

if not exist .venv (
  echo Creating virtual environment...
  %PY% -m venv .venv || (echo venv failed & pause & exit /b 1)
)
call .venv\Scripts\activate.bat
python -c "import numba, numpy" >nul 2>nul
if errorlevel 1 (
  echo Installing numpy and numba ^(first run only^)...
  python -m pip install --upgrade pip >nul 2>nul
  python -m pip install -r requirements.txt || (echo pip install failed. Numba needs Python 3.9-3.12/3.13. & pause & exit /b 1)
)

where bun >nul 2>nul
if not errorlevel 1 (
  if not exist node_modules bun install
  if not exist data\broker (
    echo No D1 data found, downloading it with Bun ^(this takes a while^)...
    bun run fetch-broker
  )
  start "Strat panel" /min bun launcher.js
) else (
  if not exist data\broker echo Bun not installed: no data download. Use the CSV button or Sample on the page, or install Bun from https://bun.sh
)
if exist data\broker_h1 if not exist data\broker_h4 python py\resample.py

start "" http://127.0.0.1:8765/
echo App: http://127.0.0.1:8765/   ^(control panel + data sync: http://localhost:3000 if Bun is installed^)
python py\server.py %*
pause
