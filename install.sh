#!/usr/bin/env bash
# Configure pi to use an NInfer server. Linux / macOS.
# Public one-line install:
#   curl -fsSL https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/install.sh | bash
set -euo pipefail

REPOSITORY="${PI_INSTALL_REPOSITORY:-rdisruptorpost/pi-ninfer-client}"
REPOSITORY_REF="${PI_INSTALL_REF:-main}"
SOURCE_PATH="${BASH_SOURCE[0]:-}"
SOURCE_DIR="$(cd "$(dirname "${SOURCE_PATH:-.}")" 2>/dev/null && pwd || pwd)"

# A script fetched through `curl | bash` arrives without its templates and
# extensions. Fetch the repository archive, validate every extraction path,
# then hand off to the same installer used by a local checkout.
if [ ! -f "$SOURCE_PATH" ] || [ ! -f "$SOURCE_DIR/templates/models.json" ]; then
  command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
  command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
  BOOTSTRAP_WORK="$(mktemp -d)"
  trap 'rm -rf "$BOOTSTRAP_WORK"' EXIT
  ARCHIVE="$BOOTSTRAP_WORK/source.zip"
  echo "==> fetching $REPOSITORY@$REPOSITORY_REF from GitHub"
  curl -fsSL --proto '=https' --tlsv1.2 \
    "https://github.com/$REPOSITORY/archive/refs/heads/$REPOSITORY_REF.zip" \
    -o "$ARCHIVE"
  python3 - "$ARCHIVE" "$BOOTSTRAP_WORK" <<'BOOTSTRAP_PY'
import pathlib
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(archive) as bundle:
    for member in bundle.infolist():
        target = (destination / member.filename).resolve()
        if destination != target and destination not in target.parents:
            raise SystemExit(f"unsafe path in repository archive: {member.filename}")
    bundle.extractall(destination)
BOOTSTRAP_PY
  BUNDLED_INSTALLER="$(find "$BOOTSTRAP_WORK" -mindepth 2 -maxdepth 2 -name install.sh -type f -print -quit)"
  [ -n "$BUNDLED_INSTALLER" ] || { echo "install.sh not found in the GitHub archive" >&2; exit 1; }
  bash "$BUNDLED_INSTALLER" "$@" </dev/null
  exit $?
fi

HERE="$SOURCE_DIR"
BASE_URL="${PI_NINFER_URL:-}"
API_KEY="${PI_NINFER_API_KEY:-}"
SERVER_HOST="${PI_NINFER_HOST:-}"
SERVER_PORT="${PI_NINFER_PORT:-}"
SERVER_SCHEME="${PI_NINFER_SCHEME:-http}"
PROVIDER_ID="ninfer-rtx6000"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) BASE_URL="$2"; shift 2;;
    --host) SERVER_HOST="$2"; shift 2;;
    --port) SERVER_PORT="$2"; shift 2;;
    --scheme) SERVER_SCHEME="$2"; shift 2;;
    --key) API_KEY="$2"; shift 2;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

need_tty () {
  if ! { : < /dev/tty; } 2>/dev/null; then
    echo "A terminal is required for missing connection details." >&2
    echo "Alternatively set PI_NINFER_HOST, PI_NINFER_PORT and PI_NINFER_API_KEY." >&2
    exit 1
  fi
}

if [ -z "$BASE_URL" ]; then
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
  BASE_URL="$SERVER_SCHEME://$ENDPOINT_HOST:$SERVER_PORT"
fi
if [ -z "$API_KEY" ]; then
  need_tty
  printf 'NInfer API key: ' > /dev/tty
  IFS= read -rs API_KEY < /dev/tty
  echo > /dev/tty
fi
[[ "$BASE_URL" =~ ^https?://[^/[:space:]]+/?$ ]] \
  || { echo "server URL must be an http(s) origin with no path" >&2; exit 2; }
BASE_URL="${BASE_URL%/}"

command -v pi >/dev/null || { echo "pi not found on PATH. Install pi first." >&2; exit 1; }
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date +%Y%m%d-%H%M%S)"
backup () { [ -e "$1" ] && cp -r "$1" "$1.bak-$STAMP" && echo "  backed up $(basename "$1")"; return 0; }

echo "==> checking the server is reachable"
curl -fsS -m 10 "$BASE_URL/health" >/dev/null || { echo "cannot reach $BASE_URL/health" >&2; exit 1; }
curl -fsS -m 10 "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY" >/dev/null \
  || { echo "server reachable but the API key was rejected" >&2; exit 1; }
echo "    ok"

echo "==> installing pi packages"
pi install npm:pi-web-access            >/dev/null
# Pin the cross-extension API we test against. 31.x requires command-judge to
# resolve the service by session id; leaving this floating previously upgraded
# fresh clients past the API the bundled judge expected.
pi install npm:@gotgenes/pi-permission-system@31.1.3 >/dev/null
pi install npm:@gotgenes/pi-subagents   >/dev/null
echo "    web access, permission system, subagents"

echo "==> writing config to $AGENT_DIR"
mkdir -p "$AGENT_DIR/agents" "$AGENT_DIR/extensions/pi-permission-system"
backup "$AGENT_DIR/models.json"
# This package intentionally configures one NInfer endpoint at a time. Replace
# the provider map with the qualified RTX PRO 6000 configuration.
PI_INSTALL_BASE_URL="$BASE_URL/v1" PI_INSTALL_API_KEY="$API_KEY" \
python3 - "$AGENT_DIR/models.json" "$HERE/templates/models.json" <<'MODELS_PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
config = json.loads(pathlib.Path(sys.argv[2]).read_text())
provider = config["providers"]["ninfer-rtx6000"]
provider["baseUrl"] = os.environ["PI_INSTALL_BASE_URL"]
provider["apiKey"] = os.environ["PI_INSTALL_API_KEY"]
fd, temporary = tempfile.mkstemp(prefix="models.", suffix=".json", dir=path.parent)
with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(config, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
os.replace(temporary, path)
MODELS_PY
chmod 600 "$AGENT_DIR/models.json"
backup "$AGENT_DIR/extensions/pi-permission-system/config.json"
cp "$HERE/templates/permission-config.json" "$AGENT_DIR/extensions/pi-permission-system/config.json"
backup "$AGENT_DIR/subagents.json"
cp "$HERE/templates/subagents.json" "$AGENT_DIR/subagents.json"
cp "$HERE"/agents/*.md "$AGENT_DIR/agents/"

# settings.json belongs to the user (theme, thinking level, packages), so merge
# rather than overwrite. The 32k reserve is intentionally larger than the 16k
# generation budget: tool-heavy turns can jump well past the threshold, and warm
# compaction itself needs room for its instruction and summary.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$AGENT_DIR/settings.json" <<'SETTINGS_PY' && echo "    settings.json: compaction.reserveTokens = 32768"
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
try:
    cfg = json.loads(p.read_text())
except Exception:
    cfg = {}
if not isinstance(cfg, dict):
    cfg = {}
cfg.setdefault("compaction", {})["reserveTokens"] = 32768
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(cfg, indent=2) + "\n")
SETTINGS_PY
else
  echo "    WARNING: python3 not found; set compaction.reserveTokens=32768 in settings.json by hand"
fi
echo "    models.json, permission policy, subagents.json, $(ls "$HERE"/agents/*.md | wc -l) agent types"

install_extension () {   # $1 = name, rest = dep specs (scope/pkg[:source])
  local name="$1"; shift
  local ext="$AGENT_DIR/extensions/$name"
  for dep in "$@"; do
    local target="$ext/node_modules/${dep%%:*}"
    if [ -L "$target" ]; then rm -f "$target"
    elif [ -d "$target" ]; then rm -rf "$target"; fi
  done
  mkdir -p "$ext/node_modules/@earendil-works" "$ext/node_modules/@gotgenes"
  cp "$HERE/extensions/$name/index.ts" "$ext/index.ts"
  printf '{ "name": "%s", "private": true, "type": "module" }\n' "$name" > "$ext/package.json"
}

echo "==> installing extensions"
EXT="$AGENT_DIR/extensions/command-judge"
# Replace any previous install. `ln -sfn` replaces a symlink, but if a real
# directory is sitting at the path it silently creates the link *inside* it.
for old in "$EXT/node_modules/@earendil-works/pi-coding-agent" \
           "$EXT/node_modules/@earendil-works/pi-ai" \
           "$EXT/node_modules/@gotgenes/pi-permission-system"; do
  if [ -L "$old" ]; then rm -f "$old"          # symlink: remove the link only
  elif [ -d "$old" ]; then rm -rf "$old"; fi   # real directory: remove it
done
mkdir -p "$EXT/node_modules/@earendil-works" "$EXT/node_modules/@gotgenes"
cp "$HERE/extensions/command-judge/index.ts" "$EXT/index.ts"
printf '{ "name": "command-judge", "private": true, "type": "module" }\n' > "$EXT/package.json"
PI_ROOT="$(npm root -g)"
CA="$PI_ROOT/@earendil-works/pi-coding-agent"
[ -d "$CA" ] || CA="$(dirname "$(readlink -f "$(command -v pi)")")/../lib/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$EXT/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$CA/node_modules/@earendil-works/pi-ai" "$EXT/node_modules/@earendil-works/pi-ai"
ln -sfn "$AGENT_DIR/npm/node_modules/@gotgenes/pi-permission-system" \
        "$EXT/node_modules/@gotgenes/pi-permission-system"
ok=1
for m in @earendil-works/pi-ai @earendil-works/pi-coding-agent @gotgenes/pi-permission-system; do
  [ -e "$EXT/node_modules/$m/package.json" ] || { echo "    MISSING $m" >&2; ok=0; }
done
[ "$ok" = 1 ] && echo "    linked 3 dependencies" \
  || echo "    WARNING: judge deps unresolved; it will be skipped fail-safe (more prompts, never fewer)"

ACT="$AGENT_DIR/extensions/activity"
install_extension activity "@earendil-works/pi-coding-agent"
cp "$HERE"/extensions/activity/anim.ts "$ACT"/ 2>/dev/null || true
cp "$HERE"/extensions/activity/LICENSE.animations "$ACT"/ 2>/dev/null || true
ln -sfn "$CA" "$ACT/node_modules/@earendil-works/pi-coding-agent"
[ -e "$ACT/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    activity (verbose progress + tok/s)" \
  || echo "    WARNING: activity dep unresolved; it will not load"

# ninfer-tui is multi-file, so it is copied wholesale rather than via
# install_extension (which handles single index.ts extensions).
TUI="$AGENT_DIR/extensions/ninfer-tui"
for dep in "@earendil-works/pi-coding-agent"; do
  t="$TUI/node_modules/$dep"
  if [ -L "$t" ]; then rm -f "$t"; elif [ -d "$t" ]; then rm -rf "$t"; fi
done
mkdir -p "$TUI/node_modules/@earendil-works"
cp "$HERE"/extensions/ninfer-tui/*.ts "$TUI"/
cp "$HERE"/extensions/ninfer-tui/*.md "$HERE"/extensions/ninfer-tui/LICENSE.upstream "$TUI"/ 2>/dev/null || true
printf '{ "name": "ninfer-tui", "private": true, "type": "module" }\n' > "$TUI/package.json"
ln -sfn "$CA" "$TUI/node_modules/@earendil-works/pi-coding-agent"
[ -e "$TUI/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    ninfer-tui (themed header/footer, tok/s instead of \$cost)" \
  || echo "    WARNING: ninfer-tui dep unresolved; it will not load"

EFF="$AGENT_DIR/extensions/effort"
install_extension effort "@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$EFF/node_modules/@earendil-works/pi-coding-agent"
[ -e "$EFF/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    effort (/effort, /thinking commands)" \
  || echo "    WARNING: effort dep unresolved; it will not load"

# digest renders its own transcript entry, so it needs pi-tui as well.
DIG="$AGENT_DIR/extensions/digest"
install_extension digest "@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$DIG/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$CA/node_modules/@earendil-works/pi-tui" "$DIG/node_modules/@earendil-works/pi-tui"
dok=1
for m in pi-coding-agent pi-tui; do
  [ -e "$DIG/node_modules/@earendil-works/$m/package.json" ] || dok=0
done
[ "$dok" = 1 ] && echo "    digest (/digest — short summary under each long answer)" \
  || echo "    WARNING: digest deps unresolved; it will not load"

FC="$AGENT_DIR/extensions/fast-compact"
install_extension fast-compact "@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$FC/node_modules/@earendil-works/pi-coding-agent"
[ -e "$FC/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    fast-compact (/fastcompact — warm-prefix compaction)" \
  || echo "    WARNING: fast-compact dep unresolved; pi's own compaction still applies"

IW="$AGENT_DIR/extensions/image-window"
install_extension image-window "@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$IW/node_modules/@earendil-works/pi-coding-agent"
[ -e "$IW/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    image-window (/images — keeps long image sessions under the media limit)" \
  || echo "    WARNING: image-window dep unresolved; it will not load"

AC="$AGENT_DIR/extensions/auto-continue"
install_extension auto-continue "@earendil-works/pi-coding-agent"
ln -sfn "$CA" "$AC/node_modules/@earendil-works/pi-coding-agent"
[ -e "$AC/node_modules/@earendil-works/pi-coding-agent/package.json" ] \
  && echo "    auto-continue (/continue — resumes replies cut off at the output limit)" \
  || echo "    WARNING: auto-continue dep unresolved; it will not load"

echo "==> checking for conflicting extensions"
others="$(find "$AGENT_DIR/extensions" -maxdepth 1 -name '*.ts' -type f 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')"
[ -n "$others" ] \
  && echo "    WARNING: loose extension(s) alongside command-judge: $others" \
  && echo "    If pi reports a tool-name conflict, move the offending file out of $AGENT_DIR/extensions" \
  || echo "    none"

echo "==> smoke test"
OUT="$(pi -p --no-session --provider "$PROVIDER_ID" --model qwen3.8-27b:low 'Reply with exactly: READY' </dev/null 2>&1 | tail -1)"
echo "    $OUT"
case "$OUT" in *READY*) echo; echo "Done. Start with:  pi --provider $PROVIDER_ID --model qwen3.8-27b:low";;
  *) echo; echo "Smoke test did not return READY — see the output above." >&2; exit 1;; esac
