@echo off
setlocal
cd /d "%~dp0"
call "%~dp0start-windows.cmd" --user-data-dir="%~dp0.tools\validation-300"
