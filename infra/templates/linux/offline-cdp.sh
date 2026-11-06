#!/usr/bin/env bash
# No browser sandbox bypass; exercise the same native Chromium/CDP contract used by guests.
set -euo pipefail
python3 -I /mnt/seed/build/offline-cdp.py
