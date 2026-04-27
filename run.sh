#!/usr/bin/env bash
# Local dev launcher for iTIC Probe Viewer.
#   ./run.sh             # install deps if missing, preprocess if missing, then serve
#   ./run.sh --serve     # skip preprocess, just serve
#   ./run.sh --rebuild   # force re-run preprocess
#   ./run.sh --limit N   # preprocess only the first N days
set -euo pipefail
cd "$(dirname "$0")"

MODE=auto
LIMIT=

while [[ $# -gt 0 ]]; do
  case "$1" in
    --serve)   MODE=serve;   shift ;;
    --rebuild) MODE=rebuild; shift ;;
    --limit)   LIMIT="${2:?--limit needs a number}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--serve] [--rebuild] [--limit N]"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js not found in PATH"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm not found in PATH";  exit 1; }

if [[ ! -f webgis/app/node_modules/vite/bin/vite.js ]]; then
  echo "[1/3] Installing frontend dependencies..."
  ( cd webgis/app && npm install --no-audit --no-fund )
else
  echo "[1/3] Dependencies present, skipping npm install."
fi

DO_PREP=0
[[ "$MODE" == "rebuild" ]] && DO_PREP=1
[[ ! -f webgis/app/public/data/meta.json ]] && DO_PREP=1
[[ "$MODE" == "serve" ]] && DO_PREP=0

if [[ "$DO_PREP" == "1" ]]; then
  echo "[2/3] Running preprocess..."
  if [[ -n "$LIMIT" ]]; then
    ( cd webgis/preprocess && LIMIT="$LIMIT" node preprocess.mjs )
  else
    ( cd webgis/preprocess && node preprocess.mjs )
  fi
else
  echo "[2/3] Preprocessed data present, skipping. (--rebuild to redo)"
fi

echo "[3/3] Starting Vite dev server at http://127.0.0.1:5173/"
echo "      Ctrl+C to stop."
cd webgis/app
exec npm run dev -- --open
