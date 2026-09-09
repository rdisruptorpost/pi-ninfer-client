#!/usr/bin/env bash
# Update an existing Linux/macOS client from the public GitHub repository.
set -euo pipefail

REPOSITORY="${PI_INSTALL_REPOSITORY:-rdisruptorpost/pi-ninfer-client}"
REPOSITORY_REF="${PI_INSTALL_REF:-main}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
URL="${PI_NINFER_URL:-}"
KEY="${PI_NINFER_API_KEY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

# Reuse local connection details when possible. Nothing is sent anywhere except
# to the configured inference server and GitHub, and the key is never printed.
if { [ -z "$URL" ] || [ -z "$KEY" ]; } && [ -f "$AGENT_DIR/models.json" ]; then
  eval "$(python3 - "$AGENT_DIR/models.json" <<'PY'
import json
import shlex
import sys

try:
    provider = json.load(open(sys.argv[1], encoding="utf-8-sig"))["providers"]["ninfer-rtx6000"]
    base = str(provider.get("baseUrl", "")).rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    print(f"URL_FOUND={shlex.quote(base)}")
    print(f"KEY_FOUND={shlex.quote(str(provider.get('apiKey', '')))}")
except Exception:
    pass
PY
)" || true
  [ -z "$URL" ] && URL="${URL_FOUND:-}"
  [ -z "$KEY" ] && KEY="${KEY_FOUND:-}"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/$REPOSITORY/$REPOSITORY_REF/install.sh" \
  -o "$WORK/install.sh"
PI_NINFER_URL="$URL" PI_NINFER_API_KEY="$KEY" \
  bash "$WORK/install.sh" </dev/null
