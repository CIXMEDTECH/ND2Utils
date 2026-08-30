#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -e "$ROOT/backend"
fi

if [[ ! -d "$ROOT/frontend/dist" ]]; then
  (cd "$ROOT/frontend" && npm install && npm run build)
fi

export ND2UTILS_BIND_HOST="${ND2UTILS_BIND_HOST:-127.0.0.1}"
exec "$ROOT/.venv/bin/uvicorn" nd2utils.main:app --app-dir "$ROOT/backend" --host "$ND2UTILS_BIND_HOST" --port "${ND2UTILS_PORT:-8080}"
