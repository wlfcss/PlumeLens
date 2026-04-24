# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the PlumeLens FastAPI backend.

Produces a single-folder distribution under `dist/plumelens-engine/`：
    plumelens-engine            entry binary (uvicorn host)
    _internal/                  Python runtime + all deps

ONNX models are **not** embedded here — they live next to the binary at
runtime (electron-builder extraResources handles distribution packaging).

Run from repo root:
    uv run pyinstaller scripts/plumelens-engine.spec --clean --noconfirm
"""
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules, collect_dynamic_libs

block_cipher = None

# PyInstaller 从 spec 所在目录运行；计算项目根
HERE = Path.cwd()
ENGINE_ROOT = HERE / "engine"

# uvicorn 的 http/websocket protocol 实现通过运行时动态 import 加载
hidden_imports: list[str] = [
    *collect_submodules("uvicorn"),
    *collect_submodules("engine"),
    # onnxruntime 的 provider 模块在运行时按需加载
    "onnxruntime.capi",
    "onnxruntime.capi._pybind_state",
    # rawpy 底层 C 扩展
    "rawpy._rawpy",
    # pyarrow parquet reader
    "pyarrow._parquet",
    "pyarrow._dataset",
    "pyarrow.parquet",
    # aiosqlite 的 connection/cursor 模块
    "aiosqlite.context",
    "aiosqlite.core",
    "aiosqlite.cursor",
]

# 原生库需要 PyInstaller 显式捕获（libonnxruntime.dylib, libraw.dylib 等）
binaries: list[tuple[str, str]] = [
    *collect_dynamic_libs("onnxruntime"),
    *collect_dynamic_libs("rawpy"),
    *collect_dynamic_libs("pyarrow"),
    *collect_dynamic_libs("numpy"),
]

# Non-Python data files。注意 ONNX 模型不打包到 engine 内，由 electron-builder
# extraResources 放到 app bundle 的 Resources/ 下，引擎启动时从 env 读路径。
datas: list[tuple[str, str]] = []

a = Analysis(
    [str(ENGINE_ROOT / "__main__.py")],
    pathex=[str(HERE)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 以下模块过大且不需要（本地推理不用 torch）
        "torch",
        "torchvision",
        "transformers",
        "tensorflow",
        # 测试/开发依赖
        "pytest",
        "pyright",
        "ruff",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="plumelens-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # macOS code signing 不兼容 UPX
    console=True,  # 保留 console 便于日志输出到 Electron 主进程
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="plumelens-engine",
)
