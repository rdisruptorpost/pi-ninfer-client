#!/usr/bin/env python3
"""Isolated regression coverage for the local installer path."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install.sh"
SERVER_URL = "http://server.example.test"


def executable(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def fake_environment(base: Path) -> tuple[dict[str, str], Path]:
    fake_bin = base / "bin"
    agent_dir = base / "agent"
    pi_root = base / "pi-global"
    coding_agent = pi_root / "@earendil-works" / "pi-coding-agent"
    packages = (
        coding_agent,
        coding_agent / "node_modules" / "@earendil-works" / "pi-ai",
        coding_agent / "node_modules" / "@earendil-works" / "pi-tui",
    )
    for package in packages:
        package.mkdir(parents=True, exist_ok=True)
        (package / "package.json").write_text("{}\n", encoding="utf-8")
    fake_bin.mkdir(parents=True)
    executable(
        fake_bin / "pi",
        "#!/usr/bin/env bash\n"
        "if [ \"${1:-}\" = install ]; then\n"
        "  mkdir -p \"$PI_CODING_AGENT_DIR/npm/node_modules/@gotgenes/pi-permission-system\"\n"
        "  printf '{}\\n' > \"$PI_CODING_AGENT_DIR/npm/node_modules/@gotgenes/pi-permission-system/package.json\"\n"
        "  exit 0\n"
        "fi\n"
        "echo READY\n",
    )
    executable(fake_bin / "npm", f"#!/usr/bin/env bash\nprintf '%s\\n' '{pi_root}'\n")
    executable(fake_bin / "curl", "#!/usr/bin/env bash\nexit 0\n")
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    return env, agent_dir


def run_profile(profile: str, existing: dict | None = None) -> tuple[dict, str, Path]:
    base = Path(tempfile.mkdtemp(prefix=f"install-{profile}-"))
    env, agent_dir = fake_environment(base)
    if existing is not None:
        agent_dir.mkdir(parents=True, exist_ok=True)
        (agent_dir / "models.json").write_text(json.dumps(existing), encoding="utf-8")
    result = subprocess.run(
        ["bash", str(INSTALLER), "--profile", profile, "--url", SERVER_URL, "--key", "test-only-key"],
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
    )
    config = json.loads((agent_dir / "models.json").read_text(encoding="utf-8"))
    return config, result.stdout, agent_dir


def main() -> None:
    checks = 0

    rtx, output, agent = run_profile("rtx6000")
    provider = rtx["providers"]["ninfer-rtx6000"]
    model = provider["models"][0]
    assert set(rtx["providers"]) == {"ninfer-rtx6000"}
    assert provider["baseUrl"] == f"{SERVER_URL}/v1"
    assert provider["compat"]["supportsReasoningEffort"] is True
    assert model["contextWindow"] == 262144
    assert model["input"] == ["text", "image"]
    assert "test-only-key" not in output
    assert "--provider ninfer-rtx6000" in output
    assert (agent / "models.json").stat().st_mode & 0o077 == 0
    for extension in (
        "command-judge", "activity", "ninfer-tui", "effort", "digest",
        "fast-compact", "image-window", "auto-continue",
    ):
        assert (agent / "extensions" / extension / "index.ts").is_file(), extension
    checks += 9

    existing = {"providers": {"ninfer": {"baseUrl": "http://existing.example.test/v1", "models": []}}}
    merged, _, _ = run_profile("rtx6000", existing)
    assert set(merged["providers"]) == {"ninfer", "ninfer-rtx6000"}
    assert merged["providers"]["ninfer"]["baseUrl"] == "http://existing.example.test/v1"
    checks += 2

    default, output, _ = run_profile("default")
    assert set(default["providers"]) == {"ninfer"}
    assert default["providers"]["ninfer"]["models"][0]["contextWindow"] == 180224
    assert "--provider ninfer " in output
    checks += 3

    bad = subprocess.run(
        ["bash", str(INSTALLER), "--profile", "unknown"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    assert bad.returncode == 2 and "unknown install profile" in bad.stdout
    checks += 1

    source = INSTALLER.read_text(encoding="utf-8")
    assert "pi-permission-system@31.1.3" in source
    checks += 1
    print(f"{checks}/{checks} installer checks passed")


if __name__ == "__main__":
    main()
