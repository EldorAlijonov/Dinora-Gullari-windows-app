param(
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'

function Run-Step {
  param([string]$Command)
  Write-Host ">> $Command"
  cmd /c $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $Command"
  }
}

try {
  Run-Step "npm run runtime:node"
  Run-Step "npm run build"
  Run-Step "npm --prefix backend prune --omit=dev"

  $publishMode = if ($Publish) { "always" } else { "never" }

  if ($Publish -and -not $env:GH_TOKEN) {
    $token = (& gh auth token 2>$null)
    if ($LASTEXITCODE -eq 0 -and $token) {
      $env:GH_TOKEN = $token.Trim()
    }
  }

  if ($Publish -and -not $env:GH_TOKEN) {
    throw "GH_TOKEN topilmadi. GitHub release publish qilish uchun gh auth login qiling yoki GH_TOKEN o'rnating."
  }

  Run-Step "cross-env CSC_IDENTITY_AUTO_DISCOVERY=false WIN_CSC_LINK= CSC_LINK= electron-builder --win nsis --x64 --publish $publishMode"
} finally {
  Write-Host ">> restoring backend development dependencies"
  cmd /c "npm --prefix backend install"
}
