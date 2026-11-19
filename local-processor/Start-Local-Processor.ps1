$ErrorActionPreference = "Stop"
$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverRoot = Join-Path $installRoot "server"
$dataRoot = Join-Path $env:LOCALAPPDATA "BulkWBNGenerator\data"
$logRoot = Join-Path $env:LOCALAPPDATA "BulkWBNGenerator\logs"
$dashboardUrl = "https://bulk-wbn-generator-rpc.vercel.app"
$apiUrl = "http://127.0.0.1:4000/api/health"

New-Item -ItemType Directory -Force -Path $dataRoot, $logRoot | Out-Null
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Node.js 20 LTS or newer is required. Install Node.js, then run this shortcut again.", "Bulk WBN Generator RPC") | Out-Null
  exit 1
}

try {
  $health = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 2
} catch {
  $env:PORT = "4000"
  $env:DATA_DIR = $dataRoot
  $env:DOWNLOADS_DIR = (Join-Path $env:LOCALAPPDATA "BulkWBNGenerator\downloads")
  $env:DASHBOARD_ORIGINS = "https://bulk-wbn-generator-rpc.vercel.app"
  $stdout = Join-Path $logRoot "processor-out.log"
  $stderr = Join-Path $logRoot "processor-error.log"
  Start-Process -FilePath (Get-Command node).Source -ArgumentList "src/index.js" -WorkingDirectory $serverRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    try { $health = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 2; $ready = $true; break } catch { }
  }
  if (-not $ready) {
    $details = if (Test-Path $stderr) { Get-Content $stderr -Tail 15 | Out-String } else { "No backend log was created." }
    throw "Local Processor did not start. $details"
  }
}

$pairingCodeFile = Join-Path $dataRoot "pairing-code.txt"
$shownFlag = Join-Path $dataRoot "pairing-code-shown.flag"
if ((Test-Path $pairingCodeFile) -and -not (Test-Path $shownFlag)) {
  Start-Process notepad.exe -ArgumentList "`"$pairingCodeFile`""
  New-Item -ItemType File -Force -Path $shownFlag | Out-Null
}
try { Start-Process chrome.exe $dashboardUrl } catch { Start-Process $dashboardUrl }
