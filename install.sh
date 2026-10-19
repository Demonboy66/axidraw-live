#!/bin/bash
# Sets up AxiDraw Live: a Python environment in .venv with the AxiDraw Python API from Evil Mad Scientist.
# Needs Python 3.8 or newer. Run once:  ./install.sh
set -e
cd "$(dirname "$0")"
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || { echo "AxiDraw Live needs Python 3.8 or newer."; exit 1; }
"$PYTHON" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install https://cdn.evilmadscientist.com/dl/ad/public/AxiDraw_API.zip
echo
echo "Done. Start it with:  .venv/bin/python server.py   (or double-click 'Start AxiDraw Live.command' on a Mac)"
