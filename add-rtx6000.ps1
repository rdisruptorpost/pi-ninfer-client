<#
  Add the RTX PRO 6000 NInfer server as a second pi provider without replacing
  the existing 5090 provider.

  Public one-line install:
      irm https://raw.githubusercontent.com/rdisruptorpost/pi-ninfer-client/main/add-rtx6000.ps1 | iex
#>
param(
  [string]$Url = "",
  [string]$ServerHost = "",
  [string]$ServerPort = "",
  [ValidateSet("http", "https")][string]$Scheme = "http",
  [string]$Key = "",
  [switch]$NoSmoke
)
$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Assert-ValidJson {
  param([string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "$Path was written with a UTF-8 BOM."
  }
  try { Get-Content $Path -Raw | ConvertFrom-Json | Out-Null }
  catch { throw "$Path is not valid JSON: $_" }
}

if (-not $Url -and $env:PI_RTX6000_URL) { $Url = $env:PI_RTX6000_URL }
if (-not $ServerHost -and $env:PI_RTX6000_HOST) { $ServerHost = $env:PI_RTX6000_HOST }
if (-not $ServerPort -and $env:PI_RTX6000_PORT) { $ServerPort = $env:PI_RTX6000_PORT }
if ($env:PI_RTX6000_SCHEME) { $Scheme = $env:PI_RTX6000_SCHEME }
if ($Scheme -notin @("http", "https")) { throw "PI_RTX6000_SCHEME must be http or https" }
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
if (-not $Key -and $env:PI_RTX6000_API_KEY) { $Key = $env:PI_RTX6000_API_KEY }
if (-not $Key) {
  $secureKey = Read-Host "RTX PRO 6000 API key" -AsSecureString
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

if (-not (Get-Command pi -ErrorAction SilentlyContinue)) { throw "pi not found on PATH. Install pi first." }

Write-Host "==> checking RTX PRO 6000 at $Url"
try { Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 10 | Out-Null }
catch { throw "cannot reach $Url/health - check the address and firewall" }
try {
  Invoke-RestMethod -Uri "$Url/v1/models" -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 10 | Out-Null
} catch { throw "server reachable but the API key was rejected" }
Write-Host "    ok"

$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$env:USERPROFILE\.pi\agent" }
$ModelsPath = "$AgentDir\models.json"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
if (Test-Path $ModelsPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item $ModelsPath "$ModelsPath.bak-$stamp" -Force
  Write-Host "    backed up models.json"
  try { $config = Get-Content $ModelsPath -Raw | ConvertFrom-Json }
  catch { throw "refusing to replace invalid $ModelsPath`: $_" }
} else {
  $config = [pscustomobject]@{}
}

if (-not ($config.PSObject.Properties.Name -contains "providers")) {
  $config | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{})
}
if ($null -eq $config.providers) {
  $config.providers = [pscustomobject]@{}
}

$provider = [ordered]@{
  baseUrl = "$Url/v1"
  api = "openai-completions"
  apiKey = $Key
  authHeader = $true
  compat = [ordered]@{
    supportsStore = $false
    supportsDeveloperRole = $true
    supportsReasoningEffort = $true
    supportsUsageInStreaming = $true
    supportsFinishReason = $true
    maxTokensField = "max_tokens"
    requiresThinkingAsText = $false
    supportsStrictMode = $false
    sendSessionAffinityHeaders = $false
  }
  models = @(
    [ordered]@{
      id = "qwen3.8-27b"
      name = "Qwen3.8-27B NVFP4 (RTX PRO 6000)"
      contextWindow = 262144
      maxTokens = 16384
      reasoning = $true
      thinkingLevelMap = [ordered]@{
        off = "none"
        minimal = $null
        low = "low"
        medium = "medium"
        high = $null
        xhigh = "xhigh"
        max = $null
      }
      # The RTX PRO 6000 launch is qualified with --vision at C=8.
      input = @("text", "image")
    }
  )
}
$config.providers | Add-Member -NotePropertyName "ninfer-rtx6000" -NotePropertyValue $provider -Force

Write-Utf8NoBom $ModelsPath (($config | ConvertTo-Json -Depth 20) + "`n")
Assert-ValidJson $ModelsPath
Write-Host "==> added provider: ninfer-rtx6000"

if (-not $NoSmoke) {
  Write-Host "==> smoke test"
  $output = pi -p --no-session --provider ninfer-rtx6000 --model qwen3.8-27b:low "Reply with exactly: READY" 2>&1 | Select-Object -Last 1
  Write-Host "    $output"
  if ($output -notmatch "READY") { throw "Smoke test did not return READY; the provider was still added." }
}

Write-Host "`nDone. Open /model in pi and select Qwen3.8-27B NVFP4 (RTX PRO 6000)."
Write-Host "Direct start: pi --provider ninfer-rtx6000 --model qwen3.8-27b:low"
