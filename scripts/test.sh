#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [ $# -eq 0 ]; then
  set -- tests/*.test.js
fi
exec docker run --rm -u "$(id -u):$(id -g)" \
  -e LAST_KNOWN_PATH=/tmp/fleet-deck-test-last-known.json \
  -e SCRATCHPAD_PATH=/tmp/fleet-deck-test-scratchpad.json \
  -v "${ROOT_DIR}:/app" -w /app node:20-alpine node --test "$@"
