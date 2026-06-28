@echo off
setlocal

cd /d "%~dp0"

if "%~1"=="" (
  node "%~dp0delay-cli.js" --count 10 --delay 3000 --timeout 30000
) else (
  node "%~dp0delay-cli.js" %*
)

echo.
pause
