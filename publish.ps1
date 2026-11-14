# One command for the owner: deploy the relay + control page to your Cloudflare account, build the installer that
# points at it, and (if OBSR_RELEASE_REPO=owner/name is set) publish the installer as a GitHub release.
# Relay address: $env:OBSR_DOMAIN (a custom domain set up in relay/wrangler.jsonc) or the workers.dev address.
# Run via publish.cmd (double-click). Re-run any time to update.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$Relay = if ($env:OBSR_DOMAIN) { "https://$($env:OBSR_DOMAIN)" } else { "" }

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Run($what, [scriptblock]$cmd) { & $cmd; if ($LASTEXITCODE) { throw "$what failed" } }

Step "1/5  Installing tools (first run takes a minute)"
Push-Location relay;  Run "npm install in relay/" { npm install --no-fund --no-audit }; Pop-Location
Push-Location agent;  Run "npm install in agent/" { npm install --no-fund --no-audit }; Pop-Location

Step "2/5  Cloudflare login"
Push-Location relay
$who = npx wrangler whoami 2>&1 | Out-String
if ($who -match "not authenticated") {
  Write-Host "A browser window opens. Log in and press Allow."
  Run "Cloudflare login" { npx wrangler login }
}
Pop-Location

Step "3/5  Deploying the relay and control page to Cloudflare"
Remove-Item relay\public\dl -Recurse -Force -ErrorAction SilentlyContinue
Push-Location relay
$out = npx wrangler deploy 2>&1 | Out-String
Write-Host $out
if ($LASTEXITCODE) { throw "deploy failed" }
Pop-Location
if (-not $Relay) {
  if ($out -match "(https://[a-z0-9.-]+\.workers\.dev)") { $Relay = $Matches[1] } else { throw "Could not find the workers.dev address. Set OBSR_DOMAIN and run again." }
}

Step "4/5  Building the installer for $Relay"
Push-Location agent
$env:RELAY_URL = $Relay
Run "build" { node build.mjs }
Pop-Location
Copy-Item agent\dist\OBS-Remote-Setup.exe .\OBS-Remote-Setup.exe -Force

Step "5/5  Publishing the installer"
if ($env:OBSR_RELEASE_REPO) {
  $ghs = gh auth status 2>&1 | Out-String
  if ($ghs -notmatch "Logged in") { Run "GitHub login" { gh auth login --web -h github.com -p https } }
}
node tools\publish-download.mjs
if ($LASTEXITCODE) { throw "could not publish the installer" }
Push-Location relay; Run "deploy" { npx wrangler deploy }; Pop-Location

Write-Host "`nDone." -ForegroundColor Green
Write-Host "Control:   $Relay"
if ($env:OBSR_RELEASE_REPO) { Write-Host "Download:  https://github.com/$($env:OBSR_RELEASE_REPO)/releases/latest" }
Write-Host "Installer: $PSScriptRoot\OBS-Remote-Setup.exe (same file, for copying by hand)"
