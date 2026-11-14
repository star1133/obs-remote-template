@echo off
rem Double-click: builds OBS-Remote-Setup.exe with NO Cloudflare account. Each computer becomes its own relay with a free public link.
cd /d "%~dp0agent"
call npm install --no-fund --no-audit
set RELAY_URL=
node build.mjs
if errorlevel 1 (echo Build failed & pause & exit /b 1)
copy /y dist\OBS-Remote-Setup.exe "%~dp0OBS-Remote-Setup.exe"
echo.
echo Done: %~dp0OBS-Remote-Setup.exe
pause
