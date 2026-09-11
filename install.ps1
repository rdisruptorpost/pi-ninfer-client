<#
  Configure pi to use an NInfer server. Windows.
  Public install:
    irm https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/install.ps1 | iex
#>
param(
  [string]$Url = "",
  [string]$ServerHost = "",
  [string]$ServerPort = "",
  [ValidateSet("http", "https")][string]$Scheme = "http",
  [string]$Key = ""
)
$ErrorActionPreference = "Stop"

$Repository = if ($env:PI_INSTALL_REPOSITORY) { $env:PI_INSTALL_REPOSITORY } else { "rdisruptorpost/pi-ninfer-client" }
$RepositoryRef = if ($env:PI_INSTALL_REF) { $env:PI_INSTALL_REF } else { "main" }
$SourceCommit = if ($env:PI_INSTALL_COMMIT) { $env:PI_INSTALL_COMMIT } else { "" }
$Here = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { "" }
if (-not $Here -or -not (Test-Path "$Here\templates\models.json")) {
  $BootstrapWork = Join-Path $env:TEMP ("pi-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $BootstrapWork | Out-Null
  try {
    if (-not $SourceCommit) {
      $CommitInfo = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/$Repository/commits/$RepositoryRef" `
        -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "pi-ninfer-client-installer" }
      $SourceCommit = [string]$CommitInfo.sha
    }
    if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
      throw "could not resolve an exact Git commit for $Repository@$RepositoryRef"
    }
    Write-Host "==> fetching $Repository@$($SourceCommit.Substring(0, 7)) from GitHub"
    $Archive = Join-Path $BootstrapWork "source.zip"
    Invoke-WebRequest -Uri "https://github.com/$Repository/archive/$SourceCommit.zip" -OutFile $Archive -UseBasicParsing
    Expand-Archive -Path $Archive -DestinationPath $BootstrapWork -Force
    $BundledInstaller = Get-ChildItem $BootstrapWork -Recurse -Filter install.ps1 |
      Where-Object { Test-Path (Join-Path $_.DirectoryName "templates\models.json") } |
      Select-Object -First 1
    if (-not $BundledInstaller) { throw "install.ps1 not found in the GitHub archive" }
    $PreviousCommit = $env:PI_INSTALL_COMMIT
    try {
      $env:PI_INSTALL_COMMIT = $SourceCommit
      & $BundledInstaller.FullName -Url $Url -ServerHost $ServerHost -ServerPort $ServerPort `
        -Scheme $Scheme -Key $Key
    } finally {
      $env:PI_INSTALL_COMMIT = $PreviousCommit
    }
  } finally {
    Remove-Item $BootstrapWork -Recurse -Force -ErrorAction SilentlyContinue
  }
  return
}

if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$' -and (Get-Command git -ErrorAction SilentlyContinue)) {
  try { $SourceCommit = (& git -C $Here rev-parse HEAD 2>$null).Trim() } catch { $SourceCommit = "" }
}
if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') { $SourceCommit = "unknown" }

# Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM (EF BB BF),
# which every JSON parser rejects. -Encoding utf8NoBOM only exists in PS7, so
# write through .NET instead: correct on both 5.1 and 7.

# Remove a path that may be a junction/symlink. A plain Remove-Item -Recurse on a
# junction can FOLLOW it and delete the target's contents -- here that would wipe
# pi's own node_modules. Delete the reparse point itself instead.
function Remove-LinkOrDir {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $item = Get-Item $Path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    [System.IO.Directory]::Delete($Path, $false)   # never follows the link
  } elseif ($item.PSIsContainer) {
    Remove-Item $Path -Recurse -Force
  } else {
    Remove-Item $Path -Force
  }
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Assert-ValidJson {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "$Path was written with a UTF-8 BOM - JSON parsers will reject it."
  }
  try { Get-Content $Path -Raw | ConvertFrom-Json | Out-Null }
  catch { throw "$Path is not valid JSON: $_" }
}

if (-not $Url -and $env:PI_NINFER_URL) { $Url = $env:PI_NINFER_URL }
if (-not $ServerHost -and $env:PI_NINFER_HOST) { $ServerHost = $env:PI_NINFER_HOST }
if (-not $ServerPort -and $env:PI_NINFER_PORT) { $ServerPort = $env:PI_NINFER_PORT }
if ($env:PI_NINFER_SCHEME) { $Scheme = $env:PI_NINFER_SCHEME }
if ($Scheme -notin @("http", "https")) { throw "PI_NINFER_SCHEME must be http or https" }
if (-not $Url) {
  if (-not $ServerHost) { $ServerHost = Read-Host "NInfer server IP or hostname" }
  if (-not $ServerPort) { $ServerPort = Read-Host "NInfer server port" }
  if ($ServerHost -match '[/@\s]') { throw "invalid server host" }
  $portNumber = 0
  if (-not [int]::TryParse($ServerPort, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
    throw "server port must be an integer from 1 through 65535"
  }
  $endpointHost = if ($ServerHost.Contains(':') -and -not $ServerHost.StartsWith('[')) { "[$ServerHost]" } else { $ServerHost }
  $Url = "${Scheme}://${endpointHost}:${ServerPort}"
}
if (-not $Key -and $env:PI_NINFER_API_KEY) { $Key = $env:PI_NINFER_API_KEY }
if (-not $Key) {
  $secureKey = Read-Host "NInfer API key" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$Url = $Url.TrimEnd('/')
$parsedUrl = $null
if (-not [uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsedUrl) -or
    $parsedUrl.Scheme -notin @("http", "https") -or $parsedUrl.PathAndQuery -ne "/") {
  throw "server URL must be an http(s) origin with no path"
}
$ProviderId = "ninfer-rtx6000"

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { throw "pi not found on PATH. Install pi first." }
if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
  Write-Warning "No bash found. pi REQUIRES a bash shell on Windows - install Git for Windows, or the bash tool will not work."
}

$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$env:USERPROFILE\.pi\agent" }
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
function Backup($p) { if (Test-Path $p) { Copy-Item $p "$p.bak-$Stamp" -Recurse -Force; Write-Host "  backed up $(Split-Path $p -Leaf)" } }

Write-Host "==> checking the server is reachable"
try { Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 10 | Out-Null }
catch { throw "cannot reach $Url/health - check the address and any firewall on the server" }
try { Invoke-RestMethod -Uri "$Url/v1/models" -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 10 | Out-Null }
catch { throw "server reachable but the API key was rejected" }
Write-Host "    ok"

Write-Host "==> installing pi packages"
pi install npm:pi-web-access | Out-Null
# Pin the cross-extension API that the bundled command judge is tested against.
pi install npm:@gotgenes/pi-permission-system@31.1.3 | Out-Null
pi install npm:@gotgenes/pi-subagents | Out-Null
Write-Host "    web access, permission system, subagents"

Write-Host "==> writing config to $AgentDir"
New-Item -ItemType Directory -Force -Path "$AgentDir\agents", "$AgentDir\extensions\pi-permission-system" | Out-Null
Backup "$AgentDir\models.json"
$ModelsConfig = Get-Content "$Here\templates\models.json" -Raw | ConvertFrom-Json
$FreshProvider = $ModelsConfig.providers.'ninfer-rtx6000'
$FreshProvider.baseUrl = "$Url/v1"
$FreshProvider.apiKey = $Key
$ModelsPath = "$AgentDir\models.json"
Write-Utf8NoBom $ModelsPath (($ModelsConfig | ConvertTo-Json -Depth 20) + "`n")
Assert-ValidJson "$AgentDir\models.json"
$ClientBuild = [ordered]@{
  repository = $Repository
  ref = $RepositoryRef
  commit = $SourceCommit
}
Write-Utf8NoBom "$AgentDir\client-build.json" (($ClientBuild | ConvertTo-Json) + "`n")
Assert-ValidJson "$AgentDir\client-build.json"
Backup "$AgentDir\extensions\pi-permission-system\config.json"
Copy-Item "$Here\templates\permission-config.json" "$AgentDir\extensions\pi-permission-system\config.json" -Force
Backup "$AgentDir\subagents.json"
Copy-Item "$Here\templates\subagents.json" "$AgentDir\subagents.json" -Force
Assert-ValidJson "$AgentDir\extensions\pi-permission-system\config.json"
Assert-ValidJson "$AgentDir\subagents.json"
Copy-Item "$Here\agents\*.md" "$AgentDir\agents\" -Force

# settings.json belongs to the user, so merge rather than overwrite. The 32k
# reserve is intentionally larger than the 16k generation budget: tool-heavy
# turns can jump past the threshold, and warm compaction needs its own headroom.
$SettingsPath = "$AgentDir\settings.json"
$Settings = if (Test-Path $SettingsPath) {
  try { Get-Content $SettingsPath -Raw | ConvertFrom-Json } catch { [pscustomobject]@{} }
} else { [pscustomobject]@{} }
if (-not $Settings.PSObject.Properties.Name.Contains("compaction")) {
  $Settings | Add-Member -NotePropertyName compaction -NotePropertyValue ([pscustomobject]@{}) -Force
}
$Settings.compaction | Add-Member -NotePropertyName reserveTokens -NotePropertyValue 32768 -Force
Write-Utf8NoBom $SettingsPath ($Settings | ConvertTo-Json -Depth 10)
Assert-ValidJson $SettingsPath
Write-Host "    settings.json: compaction.reserveTokens = 32768"
Write-Host "    models.json, client revision, permission policy, subagents.json, agent types"

Write-Host "==> installing the command judge"
$Ext = "$AgentDir\extensions\command-judge"
# Replace any previous install. Existing junctions must be cleared first --
# New-Item -ItemType Junction -Force will NOT overwrite a non-empty directory.
foreach ($old in @(
    "$Ext\node_modules\@earendil-works\pi-coding-agent",
    "$Ext\node_modules\@earendil-works\pi-ai",
    "$Ext\node_modules\@gotgenes\pi-permission-system")) {
  Remove-LinkOrDir $old
}
New-Item -ItemType Directory -Force -Path "$Ext\node_modules\@earendil-works", "$Ext\node_modules\@gotgenes" | Out-Null
Copy-Item "$Here\extensions\command-judge\index.ts" "$Ext\index.ts" -Force
Write-Utf8NoBom "$Ext\package.json" '{ "name": "command-judge", "private": true, "type": "module" }'
$Root = (npm root -g).Trim()
$Ca   = Join-Path $Root "@earendil-works\pi-coding-agent"
if (-not (Test-Path $Ca)) { throw "cannot locate @earendil-works/pi-coding-agent under $Root" }
# Junctions, not symlinks - these need no administrator rights.
New-Item -ItemType Junction -Force -Path "$Ext\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
New-Item -ItemType Junction -Force -Path "$Ext\node_modules\@earendil-works\pi-ai" -Target "$Ca\node_modules\@earendil-works\pi-ai" | Out-Null
New-Item -ItemType Junction -Force -Path "$Ext\node_modules\@gotgenes\pi-permission-system" -Target "$AgentDir\npm\node_modules\@gotgenes\pi-permission-system" | Out-Null
$missing = @("@earendil-works\pi-ai","@earendil-works\pi-coding-agent","@gotgenes\pi-permission-system") |
  Where-Object { -not (Test-Path "$Ext\node_modules\$_\package.json") }
if ($missing) { Write-Warning "judge deps unresolved: $($missing -join ', '). It will be skipped fail-safe (more prompts, never fewer)." }
else { Write-Host "    linked 3 dependencies" }

Write-Host "==> installing the activity extension"
$Act = "$AgentDir\extensions\activity"
Remove-LinkOrDir "$Act\node_modules\@earendil-works\pi-coding-agent"
Remove-LinkOrDir "$Act\node_modules\@earendil-works\pi-ai"
New-Item -ItemType Directory -Force -Path "$Act\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\activity\index.ts" "$Act\index.ts" -Force
Copy-Item "$Here\extensions\activity\anim.ts" "$Act\anim.ts" -Force
Copy-Item "$Here\extensions\activity\ninfer-progress.js" "$Act\ninfer-progress.js" -Force
Copy-Item "$Here\extensions\activity\live-command.js" "$Act\live-command.js" -Force
Copy-Item "$Here\extensions\activity\live-rate.js" "$Act\live-rate.js" -Force
Copy-Item "$Here\extensions\activity\LICENSE.animations" "$Act\LICENSE.animations" -Force -ErrorAction SilentlyContinue
Write-Utf8NoBom "$Act\package.json" '{ "name": "activity", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Act\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
New-Item -ItemType Junction -Force -Path "$Act\node_modules\@earendil-works\pi-ai" -Target "$Ca\node_modules\@earendil-works\pi-ai" | Out-Null
$activityMissing = @("@earendil-works\pi-ai","@earendil-works\pi-coding-agent") |
  Where-Object { -not (Test-Path "$Act\node_modules\$_\package.json") }
if (-not $activityMissing) {
  Write-Host "    activity (exact NInfer prefill progress + tok/s)"
} else { Write-Warning "activity deps unresolved; it will not load" }

Write-Host "==> installing ninfer-tui"
$Tui = "$AgentDir\extensions\ninfer-tui"
Remove-LinkOrDir "$Tui\node_modules\@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Force -Path "$Tui\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\ninfer-tui\*" $Tui -Force -Exclude "node_modules"
Write-Utf8NoBom "$Tui\package.json" '{ "name": "ninfer-tui", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Tui\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
if (Test-Path "$Tui\node_modules\@earendil-works\pi-coding-agent\package.json") {
  Write-Host "    ninfer-tui (themed header/footer, tok/s instead of cost)"
} else { Write-Warning "ninfer-tui dep unresolved; it will not load" }

Write-Host "==> installing the effort command"
$Eff = "$AgentDir\extensions\effort"
Remove-LinkOrDir "$Eff\node_modules\@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Force -Path "$Eff\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\effort\index.ts" "$Eff\index.ts" -Force
Write-Utf8NoBom "$Eff\package.json" '{ "name": "effort", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Eff\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
if (Test-Path "$Eff\node_modules\@earendil-works\pi-coding-agent\package.json") {
  Write-Host "    effort (/effort command)"
} else { Write-Warning "effort dep unresolved; it will not load" }

Write-Host "==> installing the digest summary"
# digest renders its own transcript entry, so it needs pi-tui as well.
$Dig = "$AgentDir\extensions\digest"
Remove-LinkOrDir "$Dig\node_modules\@earendil-works\pi-coding-agent"
Remove-LinkOrDir "$Dig\node_modules\@earendil-works\pi-tui"
New-Item -ItemType Directory -Force -Path "$Dig\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\digest\index.ts" "$Dig\index.ts" -Force
Write-Utf8NoBom "$Dig\package.json" '{ "name": "digest", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Dig\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
New-Item -ItemType Junction -Force -Path "$Dig\node_modules\@earendil-works\pi-tui" -Target "$Ca\node_modules\@earendil-works\pi-tui" | Out-Null
if ((Test-Path "$Dig\node_modules\@earendil-works\pi-coding-agent\package.json") -and
    (Test-Path "$Dig\node_modules\@earendil-works\pi-tui\package.json")) {
  Write-Host "    digest (/digest - short summary under each long answer)"
} else { Write-Warning "digest deps unresolved; it will not load" }

Write-Host "==> installing fast-compact"
$Fc = "$AgentDir\extensions\fast-compact"
Remove-LinkOrDir "$Fc\node_modules\@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Force -Path "$Fc\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\fast-compact\index.ts" "$Fc\index.ts" -Force
Write-Utf8NoBom "$Fc\package.json" '{ "name": "fast-compact", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Fc\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
if (Test-Path "$Fc\node_modules\@earendil-works\pi-coding-agent\package.json") {
  Write-Host "    fast-compact (/fastcompact - warm-prefix compaction)"
} else { Write-Warning "fast-compact dep unresolved; pi's own compaction still applies" }

Write-Host "==> installing image-window"
$Iw = "$AgentDir\extensions\image-window"
Remove-LinkOrDir "$Iw\node_modules\@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Force -Path "$Iw\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\image-window\index.ts" "$Iw\index.ts" -Force
Write-Utf8NoBom "$Iw\package.json" '{ "name": "image-window", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Iw\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
if (Test-Path "$Iw\node_modules\@earendil-works\pi-coding-agent\package.json") {
  Write-Host "    image-window (/images - keeps long image sessions under the media limit)"
} else { Write-Warning "image-window dep unresolved; it will not load" }

Write-Host "==> installing auto-continue"
$Ac = "$AgentDir\extensions\auto-continue"
Remove-LinkOrDir "$Ac\node_modules\@earendil-works\pi-coding-agent"
New-Item -ItemType Directory -Force -Path "$Ac\node_modules\@earendil-works" | Out-Null
Copy-Item "$Here\extensions\auto-continue\index.ts" "$Ac\index.ts" -Force
Write-Utf8NoBom "$Ac\package.json" '{ "name": "auto-continue", "private": true, "type": "module" }'
New-Item -ItemType Junction -Force -Path "$Ac\node_modules\@earendil-works\pi-coding-agent" -Target $Ca | Out-Null
if (Test-Path "$Ac\node_modules\@earendil-works\pi-coding-agent\package.json") {
  Write-Host "    auto-continue (/continue - resumes replies cut off at the output limit)"
} else { Write-Warning "auto-continue dep unresolved; it will not load" }

Write-Host "==> checking for conflicting extensions"
$others = @(Get-ChildItem "$AgentDir\extensions" -Filter *.ts -File -ErrorAction SilentlyContinue)
if ($others) {
  Write-Warning ("Loose extension(s) found alongside command-judge: " +
    ($others.Name -join ', ') + ". If pi reports a tool-name conflict on start, " +
    "move the offending file out of $AgentDir\extensions and re-run pi.")
} else { Write-Host "    none" }

Write-Host "==> smoke test"
$out = pi -p --no-session --provider $ProviderId --model qwen3.8-27b:low "Reply with exactly: READY" 2>&1 | Select-Object -Last 1
Write-Host "    $out"
if ($out -match "READY") { Write-Host "`nDone. Start with:  pi --provider $ProviderId --model qwen3.8-27b:low" }
else { throw "Smoke test did not return READY - see the output above." }
