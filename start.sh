#!/bin/bash
# Opens the dashboard at http://127.0.0.1:8765   (--demo shows a fake camera roll)
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || ./setup.sh || exit 1
URL="http://127.0.0.1:8765/"
if [ "$1" = "--demo" ]; then
  [ -f dashboard/demo/inventory.json ] || .venv/bin/python scripts/demo.py
  URL="${URL}?demo"
fi
(sleep 1; if command -v open >/dev/null; then open "$URL"; elif command -v xdg-open >/dev/null; then xdg-open "$URL"; fi) &
.venv/bin/python scripts/server.py
