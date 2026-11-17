@echo off
setlocal
set "PYTHONUTF8=1"
set "OMP_NUM_THREADS=4"
set "MKL_NUM_THREADS=4"
set "PLUMELENS_RESOURCES=%~dp0resources"
if not exist "%PLUMELENS_RESOURCES%\plumelens-engine\plumelens-engine.exe" set "PLUMELENS_RESOURCES=%~dp0release\win-unpacked\resources"
echo Close PlumeLens before preparing AMD GPU acceleration.
echo The first run may download an official Windows ML component and compile the detector.
"%PLUMELENS_RESOURCES%\plumelens-engine\plumelens-engine.exe" --prepare-windows-gpu --models-dir "%PLUMELENS_RESOURCES%\models" --artwork-dir "%PLUMELENS_RESOURCES%\species-artwork" %*
if errorlevel 1 (
  echo AMD preparation failed. PlumeLens can still use its compatible fallback.
  exit /b 1
)
echo AMD GPU acceleration verified. You can now start PlumeLens.
