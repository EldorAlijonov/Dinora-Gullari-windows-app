$ErrorActionPreference = 'Stop'

$nodeVersion = 'v24.11.0'
$rootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$runtimeDir = Join-Path $rootDir 'runtime'
$nodePath = Join-Path $runtimeDir 'node.exe'
$downloadUrl = "https://nodejs.org/dist/$nodeVersion/win-x64/node.exe"
$tempPath = "$nodePath.download"

if (Test-Path $nodePath) {
  Write-Host "runtime/node.exe already exists."
  exit 0
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

try {
  Write-Host "Downloading Node runtime $nodeVersion..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tempPath -UseBasicParsing
  Move-Item -LiteralPath $tempPath -Destination $nodePath -Force
  Write-Host "Node runtime saved to $nodePath"
} catch {
  if (Test-Path $tempPath) {
    Remove-Item -LiteralPath $tempPath -Force
  }

  throw
}
