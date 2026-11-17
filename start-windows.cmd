@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0release\win-unpacked\PlumeLens.exe" (
  echo Windows application has not been built. Run npm run dist:win first.
  pause
  exit /b 1
)
start "" "%~dp0release\win-unpacked\PlumeLens.exe" %*
