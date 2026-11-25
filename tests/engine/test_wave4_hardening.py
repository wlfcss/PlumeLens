"""Wave 4 regression tests for macOS entitlements, PyInstaller spec cleanup, and build freshness."""

from __future__ import annotations

import ast
import plistlib
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_macos_entitlements_do_not_allow_dyld_env_vars() -> None:
    """Hardened runtime must not grant allow-dyld-environment-variables."""
    plist_path = REPO_ROOT / "build" / "entitlements.mac.plist"
    with plist_path.open("rb") as f:
        data = plistlib.load(f)
    assert data.get("com.apple.security.cs.allow-dyld-environment-variables") is not True
    assert data.get("com.apple.security.cs.allow-jit") is True
    assert data.get("com.apple.security.cs.disable-library-validation") is True


def test_pyinstaller_cleanup_preserves_torch_testing_and_numpy_pytesttester(tmp_path: Path) -> None:
    """`_cleanup_packaging_noise` must agree with `_keep_runtime_toc_item`."""
    spec_text = (REPO_ROOT / "scripts" / "plumelens-engine.spec").read_text(encoding="utf-8")
    tree = ast.parse(spec_text)

    fn_sources: list[str] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in {
            "_remove_path",
            "_cleanup_packaging_noise",
        }:
            seg = ast.get_source_segment(spec_text, node)
            assert seg is not None
            fn_sources.append(seg)
    assert len(fn_sources) == 2

    ns: dict[str, object] = {"Path": Path, "shutil": shutil}
    exec("\n\n".join(fn_sources), ns)
    cleanup = ns["_cleanup_packaging_noise"]
    assert callable(cleanup)

    keep_torch = tmp_path / "_internal" / "torch" / "testing" / "_internal" / "common_utils.py"
    keep_numpy = tmp_path / "_internal" / "numpy" / "_pytesttester.py"
    drop_pyarrow = tmp_path / "_internal" / "pyarrow" / "tests" / "test_table.py"
    drop_random_test = tmp_path / "_internal" / "somepkg" / "test_helper.py"

    for p in (keep_torch, keep_numpy, drop_pyarrow, drop_random_test):
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("# stub\n", encoding="utf-8")

    cleanup(tmp_path)

    assert keep_torch.exists(), "torch/testing must be preserved"
    assert keep_numpy.exists(), "numpy/_pytesttester.py must be preserved"
    assert not drop_pyarrow.exists(), "pyarrow/tests must be pruned"
    assert not drop_random_test.exists(), "generic test_*.py must be pruned"


def test_build_engine_tracks_engine_data_assets() -> None:
    """scripts/build-engine.cjs sourceFiles() must include engine/data/cities1000.npz."""
    node = shutil.which("node")
    assert node is not None
    result = subprocess.run(
        [
            node,
            "-e",
            "const m = require('./scripts/build-engine.cjs');"
            "console.log(JSON.stringify(m.sourceFiles()));",
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert "cities1000.npz" in result.stdout
