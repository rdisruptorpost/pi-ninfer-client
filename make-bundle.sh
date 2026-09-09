#!/usr/bin/env bash
# Produce a local-mirror archive after the public-safety gate passes.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
python3 scripts/check-public.py
python3 - <<'PY'
import pathlib, zipfile
root = pathlib.Path(__file__).resolve().parent if "__file__" in dir() else pathlib.Path(".").resolve()
src  = pathlib.Path(".").resolve()
out  = src / "pi-ninfer-client.zip"
skip = {".git", "node_modules", "__pycache__"}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(src.rglob("*")):
        if not p.is_file() or p.is_symlink(): continue
        if any(s in p.parts for s in skip) or ".bak-" in p.name or p.suffix == ".zip": continue
        z.write(p, pathlib.Path("pi-ninfer-client") / p.relative_to(src))
print(f"built {out} ({out.stat().st_size/1024:.0f} KB)")
with zipfile.ZipFile(out) as z:
    for n in z.namelist(): print("  " + n)
PY
