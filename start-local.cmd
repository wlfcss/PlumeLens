@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.tools\node-v24.22.3-win-x64;%~dp0.tools\uv;%PATH%"
set "UV_CACHE_DIR=%~dp0.tools\uv-cache"
set "UV_PYTHON_INSTALL_DIR=%~dp0.tools\python"
set "npm_config_cache=%~dp0.tools\npm-cache"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "PLUMELENS_PYTHON=%~dp0.venv\Scripts\python.exe"
if exist "%~dp0.venv-dml\directml-verified.json" set "PLUMELENS_PYTHON=%~dp0.venv-dml\Scripts\python.exe"
if exist "%~dp0.venv-amd\amd-verified.json" set "PLUMELENS_PYTHON=%~dp0.venv-amd\Scripts\python.exe"
call npm.cmd start
