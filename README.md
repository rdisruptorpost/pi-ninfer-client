# Pi client for NInfer

A reproducible Pi client configuration for Qwen3.8-27B served by NInfer on an
RTX PRO 6000. It installs the model provider, command judge, custom terminal
UI, performance telemetry, warm-prefix compaction, image-window management,
automatic output continuation, web access, and subagent presets.

This repository contains client configuration only. Model weights, API keys,
runtime configuration, conversation logs, benchmark transcripts, build output,
and machine-specific server configuration are intentionally excluded.

## Install

Prerequisites:

- Pi installed and available on `PATH`
- `curl` and Python on Linux/macOS
- Git for Windows when using Windows, because Pi's shell tool requires Bash
- Network access to an NInfer server

Linux/macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/install.ps1 | iex
```

The installer downloads the remaining source from GitHub over HTTPS and then
prompts for the following locally:

1. NInfer server IP address or hostname
2. NInfer server port
3. NInfer API key, entered without echo

No inference endpoint or API key is embedded in this repository. The installer
creates a single `ninfer-rtx6000` provider with text and image input and a 262K
context window. Running it again replaces the previous provider configuration
after creating a timestamped local backup.

The bootstrap resolves `main` to an exact Git commit before downloading the
archive. Pi's startup header shows that installed revision as `client abc1234`
and checks it against the current branch head. Results are cached for 15 minutes
across sessions; if GitHub is unavailable, the header reports that the status is
unavailable without delaying startup. Pi's own `v0.0.1`-style version remains a
separate value.

Reviewing a remote script before executing it is always sensible:

```bash
curl -fsSL https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/install.sh -o install.sh
less install.sh
bash install.sh
```

## Update

Updates reuse the RTX PRO 6000 provider's endpoint and API key from the local
`models.json`; neither value is uploaded to GitHub or printed.

```bash
curl -fsSL https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/update.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/update.ps1 | iex
```

Restart Pi after an install or update so every extension is reloaded.

## What it installs

| Component | Purpose |
|---|---|
| model provider | Qwen3.8-27B text and image input with explicit thinking levels |
| permission policy | broad read access, guarded writes, and hard-denied credential paths |
| command judge | model-reviewed shell commands with `safe` and `auto` postures |
| NInfer TUI | client revision, model, effort, cache/performance, and judge status in the terminal UI |
| activity | exact cached/prefill progress and ETA, clickable live bash commands in fullscreen mode, plus generation/tool throughput telemetry |
| fast compact | cache-friendly compaction with a bounded cold fallback |
| image window | drops old request images before the media budget is exhausted |
| auto continue | resumes responses that stop at the output limit |
| digest | optional short companion summaries for long responses |
| subagents | bounded concurrency and research/writing agent presets |

Use `alt+a` or `/mode safe|auto` to change the command-judge posture. `/mode`
also reports whether the judge is connected. `AUTO!` in the footer means the
authorizer did not register and commands will fall back to manual approval.

AUTO mode is intentionally permissive. Deterministic denials still protect
credential paths and recognizably destructive, persistent, exfiltrating, or
hidden commands, but the operator remains responsible for reviewing the policy
before enabling it.

## Repository layout

```text
agents/       subagent presets
extensions/   Pi extensions maintained by this project
scripts/      release-safety tooling
templates/    credential-free configuration templates
install.*     complete installers and GitHub bootstrap entry points
update.*      update entry points that reuse local configuration
```

The NInfer engine checkout should be versioned separately as a fork of its
upstream repository. Keeping the CUDA/C++ engine and this client package in
separate repositories preserves upstream history and prevents model artifacts
or server logs from accidentally entering the client repository.

## Development and release checks

Before committing:

```bash
python3 scripts/check-public.py
python3 tests/install_test.py
node tests/client_build_test.mjs
node tests/command_judge_test.mjs
./make-bundle.sh
```

`check-public.py` rejects IP literals, endpoint URLs containing literal ports,
absolute user-home paths, email addresses, token-shaped secrets, private keys,
logs, model artifacts, and symlinks. It reports only the file, line, and type of
finding so suspected secret values are not copied into CI output.

`make-bundle.sh` is only needed for an optional local mirror. Normal installs
download the source directly from GitHub.

## Local files and secrets

The generated Pi `models.json` contains the API key because Pi needs it to call
the server. The Linux installer restricts that file to the current user.
`client-build.json` and `client-build-cache.json` contain only public repository
revision metadata. Never commit `models.json`, activity logs, permission-review
logs, session JSONL, environment files, or installer backups.

On Windows, keep hand-written JSON encoded as UTF-8 without a byte-order mark.
The installer handles this automatically.

## License and attribution

Project-owned code is available under the MIT license. Vendored UI and
animation components retain their upstream license and attribution files inside
their extension directories.
