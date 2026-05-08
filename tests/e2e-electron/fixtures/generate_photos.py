# pyright: basic
"""生成 e2e 测试用的 fixture photos —— 从用户真实照片库拷贝 + 缩到 1280px。

用真鸟照片(不是纯色)的好处:e2e 真的能跑完整管线 — YOLO 检测 + 姿态 +
画质 + 物种识别都有数据可验证;否则纯色图永远 birds=0,只能验证 UI,验
证不了 pipeline 输出端。

source 选择逻辑(优先级):
1. PLUMELENS_E2E_PHOTO_SOURCE env var 指定的目录
2. ~/Desktop/鸟照片/<任意子目录> 中的 .JPG/.jpg 文件
3. 都没有就 fallback 到生成纯色 JPEG

输出:tests/e2e-electron/fixtures/sample_photos/IMG_0001.JPG ... IMG_0005.JPG
不入 git(.gitignore),由 npm run dist:mac 或 npm run test:e2e:packaged 自动调用。

运行:`uv run python tests/e2e-electron/fixtures/generate_photos.py`
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from PIL import Image, ImageOps

OUTPUT_DIR = Path(__file__).parent / "sample_photos"
TARGET_COUNT = 5  # 5 张够覆盖 多 photo / scene grouping / 不同 grade
MAX_DIM = 1280   # 长边缩到 1280px,YOLO 标准检测尺寸,够触发完整 pipeline
JPEG_QUALITY = 85


def find_source_photos() -> list[Path]:
    """按优先级找一批真照片,返回前 TARGET_COUNT 张。"""
    explicit = os.environ.get("PLUMELENS_E2E_PHOTO_SOURCE")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    # 用户机器默认目录(开发者跑 e2e 时通常都有真照片)
    default_root = Path.home() / "Desktop" / "鸟照片"
    if default_root.exists():
        for sub in sorted(default_root.iterdir()):
            if sub.is_dir():
                candidates.append(sub)

    for source in candidates:
        if not source.exists() or not source.is_dir():
            continue
        # 只用 JPG(scanner 也支持但走不同路径,统一 JPG 测主流场景)
        photos = sorted(source.glob("*.JPG")) + sorted(source.glob("*.jpg"))
        if len(photos) >= TARGET_COUNT:
            print(f"[fixture] using source: {source} ({len(photos)} JPGs found)")
            return photos[:TARGET_COUNT]

    return []


def shrink_and_save(src: Path, dst: Path) -> None:
    """读 src(任意尺寸),长边缩到 MAX_DIM,JPEG q=85 写到 dst。EXIF 透传。"""
    with Image.open(src) as img:
        # exif_transpose 让方向不被丢:用户照片可能 Orientation=6(竖拍)。
        img = ImageOps.exif_transpose(img) or img
        img = img.convert("RGB")
        # 长边等比缩放
        w, h = img.size
        scale = MAX_DIM / max(w, h)
        if scale < 1.0:
            new_w = int(round(w * scale))
            new_h = int(round(h * scale))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        # 保留原 EXIF(让 scanner 能解析 DateTimeOriginal / GPSInfo)
        exif_bytes = img.info.get("exif", b"")
        img.save(dst, "JPEG", quality=JPEG_QUALITY, exif=exif_bytes)


def fallback_solid_colors() -> None:
    """没找到真照片时用纯色兜底 — 至少能验证 UI 链路,只是 birds=0。"""
    print("[fixture] no real photos found, falling back to solid color JPEGs")
    colors: tuple[tuple[str, tuple[int, int, int]], ...] = (
        ("IMG_0001.JPG", (40, 100, 60)),
        ("IMG_0002.JPG", (180, 90, 50)),
        ("IMG_0003.JPG", (70, 130, 200)),
        ("IMG_0004.JPG", (200, 200, 160)),
        ("IMG_0005.JPG", (90, 70, 110)),
    )
    for name, color in colors:
        path = OUTPUT_DIR / name
        Image.new("RGB", (256, 192), color).save(path, "JPEG", quality=85)
        print(f"  wrote {path} ({path.stat().st_size} bytes)")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # 清旧 fixture(避免上次跑遗留的脏数据)
    for old in OUTPUT_DIR.glob("*.JPG"):
        old.unlink()
    for old in OUTPUT_DIR.glob("*.jpg"):
        old.unlink()

    sources = find_source_photos()
    if not sources:
        fallback_solid_colors()
        return

    for i, src in enumerate(sources, start=1):
        dst = OUTPUT_DIR / f"IMG_{i:04d}.JPG"
        shrink_and_save(src, dst)
        size_kb = dst.stat().st_size // 1024
        print(f"  {src.name} → {dst.name} ({size_kb} KB)")
    # 留一份记录哪个 source 被用了,便于诊断
    (OUTPUT_DIR / ".source").write_text(str(sources[0].parent), encoding="utf-8")


if __name__ == "__main__":
    main()
