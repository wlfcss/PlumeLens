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
    # OpenCV (cv2) 用于场景分组（AKAZE + 颜色直方图）
    "cv2",
    # ---- DINOv3 species v3：torch + transformers + safetensors ----
    # transformers 通过 from_pretrained 动态 import 模型类
    *collect_submodules("transformers.models.dinov3_vit"),
    "transformers.models.auto",
    "transformers.models.auto.modeling_auto",
    "transformers.models.auto.configuration_auto",
    # torch 各 backend 在运行时按设备 import
    "torch._C",
    "torch.nn.functional",
    "torch.backends.mps",
    "torch.backends.cudnn",
    # safetensors 读取
    "safetensors",
    "safetensors.torch",
    # torchvision v2 transforms 按需 import 子模块
    *collect_submodules("torchvision.transforms.v2"),
]

# 原生库需要 PyInstaller 显式捕获（libonnxruntime.dylib, libraw.dylib, libtorch_*.dylib 等）
binaries: list[tuple[str, str]] = [
    *collect_dynamic_libs("onnxruntime"),
    *collect_dynamic_libs("rawpy"),
    *collect_dynamic_libs("pyarrow"),
    *collect_dynamic_libs("numpy"),
    *collect_dynamic_libs("cv2"),
    *collect_dynamic_libs("torch"),
    *collect_dynamic_libs("torchvision"),
]

# Non-Python data files。模型权重不打包到 engine 内（容易 700+MB），由 electron-builder
# extraResources 放到 app bundle 的 Resources/ 下，引擎启动时从 env 读路径。
# 但 transformers 内置的 model registry / tokenizer config 需要 collect_data_files 兜底。
from PyInstaller.utils.hooks import collect_data_files
datas: list[tuple[str, str]] = [
    *collect_data_files("transformers"),
    *collect_data_files("torch", includes=["**/*.json", "**/*.txt"]),
]

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
        # tensorflow 不用（transformers 兼容多 backend，但我们只需 torch path）
        "tensorflow",
        "tensorflow_addons",
        "jax",
        "flax",
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
