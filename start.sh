#!/bin/bash
# Opens the photo sorter at http://127.0.0.1:8765. Safe to run again: if it's already running it just opens the page.
#   ./start.sh          your photos
#   ./start.sh --demo   a fake camera roll, to see what it looks like
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
URL="http://127.0.0.1:$PORT/"
[ "$1" = "--demo" ] && URL="${URL}?demo"
open_page() { if command -v open >/dev/null; then open "$1"; elif command -v xdg-open >/dev/null; then xdg-open "$1"; else echo "Open $1"; fi; }
if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
  echo "Photo sorter is already running."
  open_page "$URL"
  exit 0
fi
[ -x .venv/bin/python ] || ./setup.sh || exit 1
if [ "$1" = "--demo" ] && [ ! -f dashboard/demo/mini/0.jpg ]; then .venv/bin/python scripts/demo.py; fi
(sleep 1; open_page "$URL") &
PORT="$PORT" exec .venv/bin/python scripts/server.py
