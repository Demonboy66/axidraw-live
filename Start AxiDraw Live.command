#!/bin/bash
# Double-click to start AxiDraw Live; it opens in your browser. Close this window to stop it.
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up (this downloads the AxiDraw software from Evil Mad Scientist)..."
  ./install.sh || { echo "Setup failed - see above."; read -r -p "Press Return to close."; exit 1; }
fi
exec .venv/bin/python -W ignore server.py
