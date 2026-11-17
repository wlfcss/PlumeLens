param(
    [ValidateSet('gfx1100', 'gfx1101', 'gfx1102', 'gfx1200', 'gfx1201')]
    [string]$GfxTarget = 'gfx1100',
    [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$uvCommand = Join-Path $projectRoot '.tools\uv\uv.exe'
if (-not (Test-Path -LiteralPath $uvCommand)) { $uvCommand = (Get-Command uv -ErrorAction Stop).Source }
$env:UV_CACHE_DIR = Join-Path $projectRoot '.tools\uv-cache'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $projectRoot '.tools\python'
$env:UV_HTTP_TIMEOUT = '600'
$env:PYTHONUTF8 = '1'
New-Item -ItemType Directory -Path .tools -Force | Out-Null
& $uvCommand venv .venv-amd --python 3.12
if ($LASTEXITCODE -ne 0) { throw 'Could not create the AMD Python environment' }
$verificationMarker = Join-Path $projectRoot '.venv-amd\amd-verified.json'
if (Test-Path -LiteralPath $verificationMarker) { Remove-Item -LiteralPath $verificationMarker }
& $uvCommand export --frozen --extra dev --no-hashes --output-file .tools\locked-requirements.txt | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not export locked requirements' }
$requirements = Get-Content .tools\locked-requirements.txt | Where-Object { $_ -notmatch '^torch(vision)?==' }
[IO.File]::WriteAllLines((Join-Path $projectRoot '.tools\locked-amd-requirements.txt'), $requirements, [Text.UTF8Encoding]::new($false))
$archives = @()
if ($GfxTarget -eq 'gfx1100' -and (Test-Path .tools\amd-wheels)) {
    $archives = @(Get-ChildItem .tools\amd-wheels -File | Where-Object { $_.Name -like '*.whl' -or $_.Name -like '*.tar.gz' } | ForEach-Object FullName)
}
if ($archives.Count -ge 10) {
    & $uvCommand pip install --python .venv-amd\Scripts\python.exe @archives -r .tools\locked-amd-requirements.txt
} else {
    & $uvCommand pip install --python .venv-amd\Scripts\python.exe --index https://repo.amd.com/rocm/whl-multi-arch/ "torch[device-$GfxTarget]==2.12.0+rocm7.14.1" "torchvision[device-$GfxTarget]==0.27.0+rocm7.14.1"
    if ($LASTEXITCODE -ne 0) { throw 'AMD runtime installation failed' }
    & $uvCommand pip install --python .venv-amd\Scripts\python.exe -r .tools\locked-amd-requirements.txt
}
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
if ($InstallOnly) {
    Write-Output "AMD dependencies installed for $GfxTarget. GPU validation was not requested."
    return
}
& .\.venv-amd\Scripts\python.exe scripts\benchmark-windows.py --species --output .tools\amd-benchmark.json
if ($LASTEXITCODE -ne 0) { throw 'AMD model validation failed; the normal environment remains available' }
$report = Get-Content .tools\amd-benchmark.json -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $report.species.finite -or $report.species.cpu_top1 -ne $report.species.rocm_top1 -or $report.species.max_probability_error -gt 0.0001) { throw 'AMD output parity check failed' }
foreach ($model in $report.models.PSObject.Properties) {
    if (-not $model.Value.within_tolerance) { throw "DirectML output parity failed: $($model.Name)" }
}
Copy-Item -LiteralPath .tools\amd-benchmark.json -Destination .venv-amd\amd-verified.json
& .\.venv-amd\Scripts\python.exe scripts\setup-windows-gpu.py --output .tools\native-amd-benchmark.json
if ($LASTEXITCODE -ne 0) { Write-Warning 'Native AMD detector setup did not pass; compatible CPU/DirectML detection remains available.' }
Write-Output 'AMD validation passed. Start the application with start-local.cmd.'
