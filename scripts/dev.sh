#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -e "$ROOT/backend[dev]"
fi

if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  (cd "$ROOT/frontend" && npm install)
fi

"$ROOT/.venv/bin/uvicorn" nd2utils.main:app --app-dir "$ROOT/backend" --reload --host 127.0.0.1 --port 8000 &
API_PID=$!
trap 'kill $API_PID' EXIT
cd "$ROOT/frontend"
npm run dev
