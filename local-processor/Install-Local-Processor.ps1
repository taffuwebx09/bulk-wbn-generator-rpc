$ErrorActionPreference = "Stop"
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$baseRoot = Join-Path $env:LOCALAPPDATA "BulkWBNGenerator"
$installRoot = Join-Path $baseRoot "Processor"

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20 LTS or newer is required. Install it from https://nodejs.org/ and run this installer again." -ForegroundColor Yellow
  Read-Host "Press Enter to close"
  exit 1
}
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required. Detected major version $nodeMajor." }

New-Item -ItemType Directory -Force -Path $baseRoot | Out-Null
if (Test-Path $installRoot) { Remove-Item $installRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Copy-Item (Join-Path $sourceRoot "server") $installRoot -Recurse -Force
Copy-Item (Join-Path $sourceRoot "Start-Local-Processor.ps1") $installRoot -Force
Copy-Item (Join-Path $sourceRoot "README-LOCAL-PROCESSOR.md") $installRoot -Force

Push-Location (Join-Path $installRoot "server")
try { npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Bulk WBN Generator RPC.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = (Get-Command powershell).Source
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $installRoot 'Start-Local-Processor.ps1')`""
$shortcut.WorkingDirectory = $installRoot
$shortcut.Description = "Start Bulk WBN Local Processor and open the hosted dashboard"
$shortcut.Save()
Write-Host "Installation complete. Desktop shortcut created: $shortcutPath" -ForegroundColor Green
Write-Host "Double-click the shortcut to start the Local Processor and open the dashboard."
Read-Host "Press Enter to close"
