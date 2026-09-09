#!/usr/bin/env bash
# Compatibility entry point. install.sh now defaults to the RTX PRO 6000
# profile, but this name is retained for existing bookmarks.
set -euo pipefail

REPOSITORY="${PI_INSTALL_REPOSITORY:-rdisruptorpost/pi-ninfer-client}"
REPOSITORY_REF="${PI_INSTALL_REF:-main}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/$REPOSITORY/$REPOSITORY_REF/install.sh" \
  -o "$WORK/install.sh"
bash "$WORK/install.sh" --profile rtx6000 "$@" </dev/null
