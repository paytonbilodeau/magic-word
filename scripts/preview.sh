#!/usr/bin/env bash
# Compatibility launcher for the offline Node/SQLite preview.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -gt 0 ]; then
  echo "Use MAGICWORD_DATA_DIR to open a separate sample inbox." >&2
  exit 2
fi
exec node scripts/host.mjs
