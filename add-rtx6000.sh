#!/usr/bin/env bash
# Add the RTX PRO 6000 NInfer server as a second pi provider without replacing
# the existing 5090 provider.
#
# Public one-line install:
#   curl -fsSL https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/add-rtx6000.sh | bash
set -euo pipefail

URL="${PI_RTX6000_URL:-}"
SERVER_HOST="${PI_RTX6000_HOST:-}"
SERVER_PORT="${PI_RTX6000_PORT:-}"
SERVER_SCHEME="${PI_RTX6000_SCHEME:-http}"
KEY="${PI_RTX6000_API_KEY:-}"
NO_SMOKE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2;;
    --host) SERVER_HOST="$2"; shift 2;;
    --port) SERVER_PORT="$2"; shift 2;;
    --scheme) SERVER_SCHEME="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --no-smoke) NO_SMOKE=1; shift;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

command -v pi >/dev/null || { echo "pi not found on PATH. Install pi first." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required to merge models.json safely." >&2; exit 1; }

need_tty () {
  { : < /dev/tty; } 2>/dev/null || {
    echo "A terminal is required for missing connection details." >&2
    exit 1
  }
}
if [ -z "$URL" ]; then
  if [ -z "$SERVER_HOST" ]; then
    need_tty
    printf 'NInfer server IP or hostname: ' > /dev/tty
    IFS= read -r SERVER_HOST < /dev/tty
  fi
  if [ -z "$SERVER_PORT" ]; then
    need_tty
    printf 'NInfer server port: ' > /dev/tty
    IFS= read -r SERVER_PORT < /dev/tty
  fi
  case "$SERVER_SCHEME" in http|https) ;; *) echo "scheme must be http or https" >&2; exit 2;; esac
  [[ "$SERVER_HOST" != *[[:space:]/@]* ]] || { echo "invalid server host" >&2; exit 2; }
  [[ "$SERVER_PORT" =~ ^[0-9]+$ ]] \
    && [ "$SERVER_PORT" -ge 1 ] && [ "$SERVER_PORT" -le 65535 ] \
    || { echo "server port must be an integer from 1 through 65535" >&2; exit 2; }
  ENDPOINT_HOST="$SERVER_HOST"
  [[ "$ENDPOINT_HOST" == *:* && "$ENDPOINT_HOST" != \[*\] ]] && ENDPOINT_HOST="[$ENDPOINT_HOST]"
  URL="$SERVER_SCHEME://$ENDPOINT_HOST:$SERVER_PORT"
fi
if [ -z "$KEY" ]; then
  need_tty
  printf 'NInfer API key: ' > /dev/tty
  IFS= read -rs KEY < /dev/tty
  echo > /dev/tty
fi
[[ "$URL" =~ ^https?://[^/[:space:]]+/?$ ]] \
  || { echo "server URL must be an http(s) origin with no path" >&2; exit 2; }
URL="${URL%/}"

echo "==> checking RTX PRO 6000 at $URL"
curl -fsS -m 10 "$URL/health" >/dev/null \
  || { echo "cannot reach $URL/health" >&2; exit 1; }
curl -fsS -m 10 "$URL/v1/models" -H "Authorization: Bearer $KEY" >/dev/null \
  || { echo "server reachable but the API key was rejected" >&2; exit 1; }
echo "    ok"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODELS="$AGENT_DIR/models.json"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$AGENT_DIR"
if [ -e "$MODELS" ]; then
  cp "$MODELS" "$MODELS.bak-$STAMP"
  echo "    backed up models.json"
fi

PI_INSTALL_BASE_URL="$URL/v1" PI_INSTALL_API_KEY="$KEY" python3 - "$MODELS" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

path = pathlib.Path(sys.argv[1])
base_url = os.environ["PI_INSTALL_BASE_URL"]
api_key = os.environ["PI_INSTALL_API_KEY"]

if path.exists():
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        raise SystemExit(f"refusing to replace invalid {path}: {exc}")
else:
    config = {}

if not isinstance(config, dict):
    raise SystemExit(f"refusing to replace {path}: JSON root is not an object")
providers = config.setdefault("providers", {})
if not isinstance(providers, dict):
    raise SystemExit(f"refusing to replace {path}: providers is not an object")

providers["ninfer-rtx6000"] = {
    "baseUrl": base_url,
    "api": "openai-completions",
    "apiKey": api_key,
    "authHeader": True,
    "compat": {
        "supportsStore": False,
        "supportsDeveloperRole": True,
        "supportsReasoningEffort": True,
        "supportsUsageInStreaming": True,
        "supportsFinishReason": True,
        "maxTokensField": "max_tokens",
        "requiresThinkingAsText": False,
        "supportsStrictMode": False,
        "sendSessionAffinityHeaders": False,
    },
    "models": [{
        "id": "qwen3.8-27b",
        "name": "Qwen3.8-27B NVFP4 (RTX PRO 6000)",
        "contextWindow": 262144,
        "maxTokens": 16384,
        "reasoning": True,
        "thinkingLevelMap": {
            "off": "none",
            "minimal": None,
            "low": "low",
            "medium": "medium",
            "high": None,
            "xhigh": "xhigh",
            "max": None,
        },
        # The RTX PRO 6000 launch is qualified with --vision at C=8.
        "input": ["text", "image"],
    }],
}

path.parent.mkdir(parents=True, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix="models.", suffix=".json", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(config, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(temporary, path)
except Exception:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
chmod 600 "$MODELS"

echo "==> added provider: ninfer-rtx6000"
if [ "$NO_SMOKE" -eq 0 ]; then
  echo "==> smoke test"
  OUT="$(pi -p --no-session --provider ninfer-rtx6000 --model qwen3.8-27b:low \
    'Reply with exactly: READY' </dev/null 2>&1 | tail -1)"
  echo "    $OUT"
  case "$OUT" in
    *READY*) ;;
    *) echo "Smoke test did not return READY; the provider was still added." >&2; exit 1;;
  esac
fi

echo
echo "Done. Open /model in pi and select Qwen3.8-27B NVFP4 (RTX PRO 6000)."
echo "Direct start: pi --provider ninfer-rtx6000 --model qwen3.8-27b:low"
