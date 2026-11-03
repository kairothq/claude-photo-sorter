#!/bin/bash
# One-time setup: checks Python and ffmpeg, installs the 3 Python packages into .venv/
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null; then
  echo "Python 3 is missing. On a Mac run: xcode-select --install   (or install from python.org)"; exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "Note: ffmpeg is not installed, so videos get grey previews."
  echo "      On a Mac with Homebrew: brew install ffmpeg"
fi
python3 -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -r requirements.txt \
  && echo "Setup done. Next: ./start.sh   (or ./start.sh --demo to see the demo)"
