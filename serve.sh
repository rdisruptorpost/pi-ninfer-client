#!/usr/bin/env bash
# Optional local mirror for a network without direct GitHub access.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${1:-}"
[ -n "$PORT" ] || { echo "usage: ./serve.sh <port>" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] \
  && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] \
  || { echo "port must be an integer from 1 through 65535" >&2; exit 2; }
./make-bundle.sh >/dev/null
echo "serving $(pwd) on the requested port"
exec python3 -m http.server "$PORT"
