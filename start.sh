#!/usr/bin/env bash
# One launcher: Python venv + deps, data check, Python backend + index.html and, if Bun exists, the original panel.
# No sudo/admin is needed. If Python is missing, this prints the install command instead of running it.
# Usage: ./start.sh [--host 0.0.0.0] [--port 8765]    (0.0.0.0 = reachable from a phone on the same Wi-Fi)
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then
  echo "Python 3 not found. Install it (needs your admin password), e.g.:"
  echo "  macOS:  brew install python@3.12"
  echo "  Debian/Ubuntu:  sudo apt install python3 python3-venv python3-pip"
  echo "  Termux:  pkg install python"
  exit 1
fi
[ -d .venv ] || "$PY" -m venv .venv || { echo "venv failed (Debian/Ubuntu: sudo apt install python3-venv)"; exit 1; }
. .venv/bin/activate
if ! python -c "import numba, numpy" 2>/dev/null; then
  echo "Installing numpy and numba (first run only)..."
  python -m pip install --upgrade pip >/dev/null 2>&1
  python -m pip install -r requirements.txt || { echo "pip install failed. Numba needs Python 3.9-3.12/3.13."; exit 1; }
fi
if command -v bun >/dev/null; then
  [ -d node_modules ] || bun install
  [ -d data/broker ] || { echo "No D1 data found, downloading with Bun (takes a while)..."; bun run fetch-broker; }
  bun launcher.js >/dev/null 2>&1 &
  BUN_PID=$!; trap 'kill $BUN_PID 2>/dev/null' EXIT
else
  [ -d data/broker ] || echo "Bun not installed: no data download. Use the CSV button or Sample on the page, or install Bun from https://bun.sh"
fi
[ -d data/broker_h1 ] && [ ! -d data/broker_h4 ] && python py/resample.py
URL="http://127.0.0.1:8765/"
( sleep 2; command -v xdg-open >/dev/null && xdg-open "$URL" || command -v open >/dev/null && open "$URL" || echo "Open $URL" ) &
echo "App: $URL   (control panel + data sync: http://localhost:3000 if Bun is installed)"
python py/server.py "$@"