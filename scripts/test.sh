#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -eq 0 ]; then
  set -- tests/*.test.js
fi
exec docker run --rm -u "$(id -u):$(id -g)" -v "${ROOT_DIR}:/app" -w /app node:20-alpine node --test "$@"
