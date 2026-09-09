<# Update an existing Windows client from the public GitHub repository. #>
$ErrorActionPreference = "Stop"

$Repository = if ($env:PI_INSTALL_REPOSITORY) { $env:PI_INSTALL_REPOSITORY } else { "rdisruptorpost/pi-ninfer-client" }
$RepositoryRef = if ($env:PI_INSTALL_REF) { $env:PI_INSTALL_REF } else { "main" }
$Profile = if ($env:PI_NINFER_PROFILE) { $env:PI_NINFER_PROFILE } else { "rtx6000" }
if ($Profile -eq "rtx6000") { $ProviderId = "ninfer-rtx6000" }
elseif ($Profile -eq "default") { $ProviderId = "ninfer" }
else { throw "PI_NINFER_PROFILE must be default or rtx6000" }

$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { "$env:USERPROFILE\.pi\agent" }
$ModelsJson = "$AgentDir\models.json"
$Url = $env:PI_NINFER_URL
$Key = $env:PI_NINFER_API_KEY
if ((-not $Url -or -not $Key) -and (Test-Path $ModelsJson)) {
  try {
    $config = Get-Content $ModelsJson -Raw | ConvertFrom-Json
    $provider = $config.providers.$ProviderId
    if (-not $Url -and $provider.baseUrl) { $Url = ($provider.baseUrl -replace '/v1/?$', '') }
    if (-not $Key -and $provider.apiKey) { $Key = $provider.apiKey }
  } catch {
    Write-Warning "could not reuse the existing provider; the installer will prompt"
  }
}

$Work = Join-Path $env:TEMP ("pi-update-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
try {
  $Installer = Join-Path $Work "install.ps1"
  Write-Host "==> fetching installer from GitHub"
  Invoke-WebRequest `
    -Uri "https://raw.githubusercontent.com/$Repository/$RepositoryRef/install.ps1" `
    -OutFile $Installer -UseBasicParsing
  & $Installer -Url $Url -Key $Key -Profile $Profile
} finally {
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}
