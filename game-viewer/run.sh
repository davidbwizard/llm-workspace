#!/usr/bin/env bash
# Build the asset catalog if needed, then serve Little Meadow or the asset viewer.
# No dependencies beyond Node; the sprite pack under assets/ is a local prerequisite.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

app=farm
port=""
rebuild=0
open_browser=1

usage() {
  cat <<'USAGE'
Usage: ./run.sh [farm|viewer] [options]

  farm            Little Meadow, the game (default, port 4175)
  viewer          the sprite catalog browser        (port 4173)

  --rebuild       regenerate the asset manifest before starting
  --port N        listen on N instead of the default
  --no-open       do not open a browser
  --test          run the test suite and exit
  -h, --help      show this message

The asset pack must be present at assets/. The manifest is generated on first
run and reused after that; pass --rebuild when the pack changes.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    farm|viewer) app="$1" ;;
    --rebuild) rebuild=1 ;;
    --no-open) open_browser=0 ;;
    --port) shift; [ $# -gt 0 ] || { echo "run.sh: --port needs a number" >&2; exit 2; }; port="$1" ;;
    --test) exec ../node_modules/.bin/vitest run --config vitest.config.mjs ;;
    -h|--help) usage; exit 0 ;;
    *) echo "run.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$port" ] && ! [[ "$port" =~ ^[0-9]+$ ]]; then
  echo "run.sh: --port must be a number, got '$port'" >&2; exit 2
fi
[ "$app" = farm ] && default_port=4175 || default_port=4173
port="${port:-$default_port}"

command -v node >/dev/null || { echo "run.sh: node is not on PATH (this project uses Node 24)" >&2; exit 1; }

major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 24 ]; then
  echo "run.sh: Node $major found; this project is verified on Node 24." >&2
  echo "        nvm use  (an .nvmrc is at the workspace root)" >&2
  exit 1
fi

if [ ! -d assets ]; then
  cat >&2 <<'MISSING'
run.sh: assets/ is missing.

The Farm RPG sprite pack is a local prerequisite and is deliberately not
committed. Restore it to game-viewer/assets/ and run this script again.
MISSING
  exit 1
fi

# The manifest is generated, gitignored, and the only "build" this project has.
if [ "$rebuild" = 1 ] || [ ! -f assets-manifest.json ]; then
  echo "Generating the asset catalog (this reads every PNG, so it takes a moment)..."
  node generate-assets.mjs
fi

if command -v lsof >/dev/null && lsof -ti:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "run.sh: port $port is already in use." >&2
  echo "        lsof -ti:$port -sTCP:LISTEN | xargs kill" >&2
  exit 1
fi

url="http://127.0.0.1:$port"
[ "$app" = farm ] && entry=farm/serve.mjs || entry=serve-viewer.mjs

node "$entry" --port "$port" &
server=$!
trap 'kill "$server" 2>/dev/null || true' INT TERM EXIT

for _ in $(seq 1 60); do
  if ! kill -0 "$server" 2>/dev/null; then
    echo "run.sh: the server exited during startup; see its output above." >&2
    exit 1
  fi
  curl -sf "$url" >/dev/null 2>&1 && break
  sleep 0.5
done

if ! curl -sf "$url" >/dev/null 2>&1; then
  echo "run.sh: $url did not respond within 30s." >&2
  exit 1
fi

echo "Ready: $url    (Ctrl+C stops it)"
if [ "$open_browser" = 1 ]; then
  if command -v open >/dev/null; then open "$url"
  elif command -v xdg-open >/dev/null; then xdg-open "$url"
  fi
fi

wait "$server"
