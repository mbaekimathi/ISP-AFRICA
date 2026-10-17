# ISP CENTRIC one-time setup for a fresh machine.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File deploy\setup.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "==> Installing Python dependencies"
python -m pip install -r (Join-Path $root "database\requirements.txt")

$dist = Join-Path $root "frontend\dist"
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "==> Building the web app"
    Push-Location (Join-Path $root "frontend")
    try {
        npm ci
        npm run build
    } finally {
        Pop-Location
    }
} elseif (Test-Path (Join-Path $dist "index.html")) {
    Write-Host "==> npm not found; using the existing frontend\dist build"
} else {
    Write-Warning "npm is not installed and frontend\dist is missing - the web app will not be served. Install Node.js or copy a built dist folder."
}

Write-Host "==> Creating the database and base tables"
python (Join-Path $root "database\seed.py")

Write-Host ""
Write-Host "Done. Start the system with:  deploy\start-isp.cmd"
