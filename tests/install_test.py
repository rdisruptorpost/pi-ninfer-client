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
INSTALLER = Path(os.environ.get("PI_INSTALLER_PATH", ROOT / "install.sh"))
SERVER_URL = "http://server.example.test"
TEST_COMMIT = "a" * 40


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
    executable(
        fake_bin / "curl",
        "#!/usr/bin/env bash\n"
        "output=''\n"
        "while [ $# -gt 0 ]; do\n"
        "  if [ \"$1\" = -o ]; then output=\"$2\"; shift 2; else shift; fi\n"
        "done\n"
        "if [ -n \"$output\" ] && [ -n \"${PI_TEST_SOURCE_ARCHIVE:-}\" ]; then\n"
        "  cp \"$PI_TEST_SOURCE_ARCHIVE\" \"$output\"\n"
        "fi\n"
        "exit 0\n",
    )
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["PI_CODING_AGENT_DIR"] = str(agent_dir)
    env["PI_INSTALL_COMMIT"] = TEST_COMMIT
    return env, agent_dir


def run_install(existing: dict | None = None) -> tuple[dict, str, Path]:
    base = Path(tempfile.mkdtemp(prefix="install-rtx6000-"))
    env, agent_dir = fake_environment(base)
    if existing is not None:
        agent_dir.mkdir(parents=True, exist_ok=True)
        (agent_dir / "models.json").write_text(json.dumps(existing), encoding="utf-8")
    result = subprocess.run(
        ["bash", str(INSTALLER), "--url", SERVER_URL, "--key", "test-only-key"],
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

    rtx, output, agent = run_install()
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
    build = json.loads((agent / "client-build.json").read_text(encoding="utf-8"))
    assert build == {
        "repository": "rdisruptorpost/pi-ninfer-client",
        "ref": "main",
        "commit": TEST_COMMIT,
    }
    assert (agent / "extensions" / "ninfer-tui" / "client-build.ts").is_file()
    for extension in (
        "command-judge", "activity", "ninfer-tui", "effort", "digest",
        "fast-compact", "image-window", "auto-continue",
    ):
        assert (agent / "extensions" / extension / "index.ts").is_file(), extension
    effort_source = (agent / "extensions" / "effort" / "index.ts").read_text(encoding="utf-8")
    assert 'registerCommand("effort"' in effort_source
    assert 'registerCommand("thinking"' not in effort_source
    checks += 13

    existing = {"providers": {"ninfer": {"baseUrl": "http://existing.example.test/v1", "models": []}}}
    replaced, _, replaced_agent = run_install(existing)
    assert set(replaced["providers"]) == {"ninfer-rtx6000"}
    backups = list(replaced_agent.glob("models.json.bak-*"))
    assert len(backups) == 1
    assert json.loads(backups[0].read_text(encoding="utf-8")) == existing
    checks += 3

    source = INSTALLER.read_text(encoding="utf-8")
    assert "pi-permission-system@31.1.3" in source
    assert "--profile" not in source
    assert "PI_NINFER_PROFILE" not in source
    checks += 3
    print(f"{checks}/{checks} installer checks passed")


if __name__ == "__main__":
    main()
