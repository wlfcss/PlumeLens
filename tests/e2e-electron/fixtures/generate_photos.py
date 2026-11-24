# pyright: basic
"""生成 e2e 测试用的确定性真鸟 fixture photos。

source 选择优先级：
1. PLUMELENS_E2E_PHOTO_SOURCE 环境变量指定的目录（自定义实拍验证）
2. 仓库自带授权鸟类图片资源 resources/species-artwork/*.webp（跨平台确定性真鸟图）
3. 均不存在时回退为纯色 JPEG（仅验证 UI 链路）

输出：tests/e2e-electron/fixtures/sample_photos/IMG_0001.JPG ... IMG_0005.JPG
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageOps

REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_DIR = Path(__file__).parent / "sample_photos"
BUNDLED_ARTWORK_DIR = REPO_ROOT / "resources" / "species-artwork"
TARGET_COUNT = 5
MAX_DIM = 1280
JPEG_QUALITY = 85

# 优先挑选 5 张清晰单鸟图作为确定性 E2E 样本（若某张不存在则顺延取目录前 5 张）
PREFERRED_ARTWORK: tuple[str, ...] = (
    "Alcedo_atthis.webp",
    "Ardeola_bacchus.webp",
    "Egretta_garzetta.webp",
    "Chlidonias_hybrida.webp",
    "Pica_serica.webp",
)


def find_source_photos() -> list[Path]:
    """按优先级返回 TARGET_COUNT 张真鸟源图。"""
    explicit = os.environ.get("PLUMELENS_E2E_PHOTO_SOURCE")
    if explicit:
        source = Path(explicit).expanduser()
        if source.is_dir():
            photos = sorted(
                p for p in source.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg"}
            )
            if len(photos) >= TARGET_COUNT:
                print(f"[fixture] using explicit source: {source} ({len(photos)} JPGs found)")
                return photos[:TARGET_COUNT]

    if BUNDLED_ARTWORK_DIR.is_dir():
        picked: list[Path] = []
        for name in PREFERRED_ARTWORK:
            candidate = BUNDLED_ARTWORK_DIR / name
            if candidate.is_file():
                picked.append(candidate)
        if len(picked) < TARGET_COUNT:
            seen = set(picked)
            for candidate in sorted(BUNDLED_ARTWORK_DIR.glob("*.webp")):
                if candidate not in seen:
                    picked.append(candidate)
                if len(picked) >= TARGET_COUNT:
                    break
        if len(picked) >= TARGET_COUNT:
            print(f"[fixture] using deterministic bundled artwork: {BUNDLED_ARTWORK_DIR}")
            return picked[:TARGET_COUNT]

    return []


def shrink_and_save(src: Path, dst: Path) -> None:
    """读取源图并转换为 RGB JPEG（长边不超过 MAX_DIM，保留原 EXIF）。"""
    with Image.open(src) as img:
        img = ImageOps.exif_transpose(img) or img
        img = img.convert("RGB")
        w, h = img.size
        scale = MAX_DIM / max(w, h)
        if scale < 1.0:
            img = img.resize(
                (int(round(w * scale)), int(round(h * scale))),
                Image.Resampling.LANCZOS,
            )
        exif_bytes = img.info.get("exif", b"")
        img.save(dst, "JPEG", quality=JPEG_QUALITY, exif=exif_bytes)


def fallback_solid_colors() -> None:
    """没找到源图时用纯色兜底。"""
    print("[fixture] no bird images found, falling back to solid color JPEGs")
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
    for old in list(OUTPUT_DIR.glob("*.JPG")) + list(OUTPUT_DIR.glob("*.jpg")):
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
    (OUTPUT_DIR / ".source").write_text(str(sources[0].parent), encoding="utf-8")


if __name__ == "__main__":
    main()
