#!/usr/bin/env bash
set -euo pipefail

URL="${FLEET_DECK_URL:-http://fleetdeck.com}"

for browser in chromium google-chrome brave-browser microsoft-edge firefox xdg-open; do
  if command -v "$browser" >/dev/null 2>&1; then
    if [ "$browser" = "xdg-open" ] || [ "$browser" = "firefox" ]; then
      exec "$browser" "$URL"
    else
      exec "$browser" --app="$URL"
    fi
  fi
done

echo "Fleet Deck: $URL"
