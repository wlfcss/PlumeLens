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
import shutil

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

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
    # numpy import-time helper; name looks test-related but numpy.__init__ needs it.
    "numpy._pytesttester",
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
    # ---- DINOv3 species v4：torch + transformers + safetensors + LoRA/reject adapter ----
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
datas: list[tuple[str, str]] = [
    *collect_data_files(
        "transformers",
        excludes=["**/test/**", "**/tests/**", "**/testing/**", "**/__pycache__/**"],
    ),
    *collect_data_files(
        "torch",
        includes=["**/*.json", "**/*.txt"],
        excludes=["**/test/**", "**/tests/**", "**/testing/**", "**/__pycache__/**"],
    ),
    # GeoNames cities1000.npz — reverse geocoding 离线兜底数据(~2.7 MB,
    # 168K 条城市/区县,自动从 services/geocoder.py 通过 _MEIPASS 加载)
    (str(ENGINE_ROOT / "data" / "cities1000.npz"), "engine/data"),
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
        "pytest_asyncio",
        "pyright",
        "ruff",
        "pyarrow.tests",
    ],
    noarchive=False,
    optimize=0,
)


def _keep_runtime_toc_item(item) -> bool:
    """Drop dependency test payloads that PyInstaller hooks may collect implicitly."""
    text = "/".join(str(part) for part in item).replace("\\", "/").lower()
    if "numpy._pytesttester" in text or "numpy/_pytesttester.py" in text:
        return True
    if "torch.testing" in text or "torch/testing/" in text:
        return True
    blocked = (
        "/tests/",
        "/test/",
        "/testing/",
        "pytest",
        "pytest_asyncio",
        "_pyarrow_cpp_tests",
        "benchmark.pxi",
    )
    return not any(pattern in text for pattern in blocked)


a.datas = [item for item in a.datas if _keep_runtime_toc_item(item)]
a.pure = [item for item in a.pure if _keep_runtime_toc_item(item)]

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


def _remove_path(path: Path) -> None:
    if not path.exists():
        return
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()


def _cleanup_packaging_noise(root: Path) -> None:
    """Remove dependency test/benchmark payloads from the frozen runtime folder."""
    exact_rel_paths = (
        "_internal/pyarrow/include",
        "_internal/pyarrow/src",
        "_internal/pyarrow/tests",
        "_internal/torch/utils/benchmark",
        "_internal/torch/distributed/rpc/_testing",
    )
    for rel in exact_rel_paths:
        _remove_path(root / rel)

    blocked_name_parts = (
        "pytest_asyncio",
        "benchmark",
        "_pyarrow_cpp_tests",
        "_tests",
        "testing",
    )
    blocked_dir_names = {"test", "tests", "testing", "__pycache__"}
    blocked_file_prefixes = ("test_",)
    blocked_file_suffixes = ("_test.py", "_tests.py", "_test.h", "_test.cc")

    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        rel = path.relative_to(root).as_posix().lower()
        name = path.name.lower()
        if any(part in rel for part in blocked_name_parts):
            _remove_path(path)
            continue
        if path.is_dir() and name in blocked_dir_names:
            _remove_path(path)
            continue
        if path.is_file() and (
            name.startswith(blocked_file_prefixes) or name.endswith(blocked_file_suffixes)
        ):
            _remove_path(path)


_cleanup_packaging_noise(HERE / "dist" / "plumelens-engine")
