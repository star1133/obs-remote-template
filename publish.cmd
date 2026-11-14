@echo off
rem Double-click: deploys the relay to your Cloudflare account and builds OBS-Remote-Setup.exe
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
echo.
pause
