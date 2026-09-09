#!/usr/bin/env python3
"""Fail when the public tree contains likely private deployment material."""

from __future__ import annotations

import math
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {".git", "node_modules", "__pycache__"}
SKIP_SUFFIXES: set[str] = set()
DENIED_SUFFIXES = {
    ".jsonl", ".log", ".ninfer", ".gguf", ".pem", ".key",
    ".zip", ".png", ".jpg", ".jpeg", ".gif", ".ico",
}
DENIED_NAMES = {
    ".env", "auth.json", "client-build-cache.json", "client-build.json",
    "command-judge.json", "settings.json",
}
ALLOWED_SPECIAL = {Path("templates/models.json")}

PATTERNS = {
    "IPv4 address": re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"),
    "URL containing an explicit port": re.compile(r"https?://[^\s/'\"]+:\d{1,5}\b", re.I),
    "absolute Linux user home": re.compile(r"(?<![\w.-])/home/[A-Za-z0-9._-]+(?:/|\b)"),
    "absolute Windows user home": re.compile(r"[A-Za-z]:\\+Users\\+[^\\\s]+", re.I),
    "email address": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
    "private key material": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "known token prefix": re.compile(r"\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})\b"),
    "literal JSON API key": re.compile(r'''["']apiKey["']\s*:\s*["'](?!__API_KEY__)[^"']+["']'''),
    "machine-style account name": re.compile(r"\brender\d+\b", re.I),
}


def candidate_paths() -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-co", "--exclude-standard"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.CalledProcessError):
        return [p for p in ROOT.rglob("*") if p.is_file() and not p.is_symlink()]
    paths = [ROOT / line for line in result.stdout.splitlines() if line]
    # `git ls-files` includes tracked paths deleted in the working tree. They
    # are absent from the release, so do not misreport them as unreadable data.
    return [path for path in paths if path.exists() or path.is_symlink()]


def entropy(value: str) -> float:
    return -sum((value.count(ch) / len(value)) * math.log2(value.count(ch) / len(value)) for ch in set(value))


def main() -> int:
    findings: list[str] = []
    for path in candidate_paths():
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            findings.append(f"{relative}: symbolic links are not allowed in the public bundle")
            continue
        if any(part in SKIP_PARTS for part in relative.parts) or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        if path.name in DENIED_NAMES or path.name.startswith(".env."):
            findings.append(f"{relative}: private runtime configuration")
            continue
        if path.name == "models.json" and relative not in ALLOWED_SPECIAL:
            findings.append(f"{relative}: private runtime model configuration")
            continue
        if path.suffix.lower() in DENIED_SUFFIXES and relative not in ALLOWED_SPECIAL:
            findings.append(f"{relative}: private/generated file type")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            findings.append(f"{relative}: unreviewed binary or unreadable file")
            continue
        for label, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{relative}:{line}: {label}")
        for match in re.finditer(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])", text):
            value = match.group(0)
            if any(ch.isdigit() for ch in value) and entropy(value) >= 4.3:
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{relative}:{line}: high-entropy token-shaped value")
    if findings:
        print("public-safety check failed:", file=sys.stderr)
        for finding in sorted(set(findings)):
            print(f"  {finding}", file=sys.stderr)
        return 1
    print("public-safety check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
