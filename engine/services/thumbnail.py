# pyright: basic
"""Dual-level thumbnail generation service.

两级缩略图策略（TECHNICAL_SPEC §8.4）：
- grid: 长边 384px, JPEG 80%, 用于网格浏览（虚拟列表大量渲染）
- preview: 长边 1920px, JPEG 85%, 用于单张预览

RAW 文件优化（TECHNICAL_SPEC §9.4）：优先用 rawpy.extract_thumb() 读取相机
内嵌的全尺寸 JPEG 预览（CR3 实测能到 8192×5464），避免完整 RAW 解码的高 CPU
开销。只有内嵌预览不够大时才回退完整解码。

缓存位置：`~/.plumelens/cache/thumbnails/{grid,preview}/{photo_id}.jpg`
"""

from __future__ import annotations

import asyncio
import io
from dataclasses import dataclass
from pathlib import Path

import structlog
from PIL import Image, ImageOps

from engine.core.database import Database
from engine.pipeline.preprocess import IMAGE_EXTENSIONS, RAW_EXTENSIONS

logger = structlog.stdlib.get_logger()

# 两级尺寸定义
GRID_LONG_EDGE = 384
PREVIEW_LONG_EDGE = 1920
GRID_QUALITY = 80
PREVIEW_QUALITY = 85

# 内嵌 RAW 预览至少需要该尺寸才能用于 preview；不够大时回退完整解码
MIN_EMBEDDED_FOR_PREVIEW = PREVIEW_LONG_EDGE


@dataclass
class ThumbnailPaths:
    """生成的缩略图文件路径（绝对路径）。"""

    grid: Path
    preview: Path


def _resize_long_edge(img: Image.Image, long_edge: int) -> Image.Image:
    """Resize preserving aspect ratio so the longer side equals `long_edge`."""
    w, h = img.size
    if max(w, h) <= long_edge:
        return img
    if w >= h:
        new_w = long_edge
        new_h = int(round(h * long_edge / w))
    else:
        new_h = long_edge
        new_w = int(round(w * long_edge / h))
    return img.resize((new_w, new_h), Image.Resampling.LANCZOS)


def _save_jpeg(img: Image.Image, out: Path, quality: int) -> None:
    """Ensure RGB + save JPEG."""
    out.parent.mkdir(parents=True, exist_ok=True)
    rgb = img.convert("RGB") if img.mode != "RGB" else img
    rgb.save(out, "JPEG", quality=quality, optimize=True)


def _load_source_image(path: Path) -> Image.Image:
    """Load an image as PIL.Image with EXIF orientation applied.

    Strategy:
    - RAW：先 rawpy.extract_thumb（通常是相机内嵌全尺寸 JPEG，几 MB 而非 60MB）
      若内嵌预览宽高都不足以生成 preview 级（<1920px），回退完整 rawpy 解码
    - 标准图：Pillow 直接打开
    """
    suffix = path.suffix.lower()

    if suffix in IMAGE_EXTENSIONS:
        img = Image.open(path)
        img.load()
        return ImageOps.exif_transpose(img) or img

    if suffix in RAW_EXTENSIONS:
        img = _load_raw_with_embedded_preview(path)
        return ImageOps.exif_transpose(img) or img

    msg = f"Unsupported image format: {suffix}"
    raise ValueError(msg)


def _load_raw_with_embedded_preview(path: Path) -> Image.Image:
    """Try embedded preview first (fast), fall back to full decode (slow but correct)."""
    import rawpy

    try:
        with rawpy.imread(str(path)) as raw:
            thumb = raw.extract_thumb()
            # rawpy.ThumbFormat 枚举值：JPEG=0, BITMAP=1（数字常量避免类型存根缺失）
            if int(thumb.format) == 0:  # JPEG
                embedded = Image.open(io.BytesIO(thumb.data))
                embedded.load()
                # 不够大 → 回退完整解码（仅当 preview 级别需要时）
                if max(embedded.size) >= MIN_EMBEDDED_FOR_PREVIEW:
                    return embedded
                # 小于阈值：继续往下走完整解码
                logger.info(
                    "Embedded RAW preview too small, falling back to full decode",
                    path=str(path),
                    size=embedded.size,
                )
            elif int(thumb.format) == 1:  # BITMAP（少见）
                import numpy as np

                bitmap: np.ndarray = thumb.data
                if bitmap.ndim == 3 and bitmap.shape[2] == 3:
                    return Image.fromarray(bitmap.astype("uint8"))
    except Exception as e:
        logger.warning(
            "extract_thumb failed, falling back to full decode",
            path=str(path),
            error=str(e),
        )

    # Fallback：完整 RAW 解码
    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(use_camera_wb=True, output_bps=8, no_auto_bright=True)
    import numpy as np

    arr: np.ndarray = rgb
    return Image.fromarray(arr.astype("uint8"))


def _generate_pair_sync(
    source: Path, photo_id: str, cache_root: Path,
) -> ThumbnailPaths:
    """同步生成 grid + preview 缩略图（runs in thread pool）。"""
    grid_path = cache_root / "grid" / f"{photo_id}.jpg"
    preview_path = cache_root / "preview" / f"{photo_id}.jpg"

    img = _load_source_image(source)

    preview_img = _resize_long_edge(img, PREVIEW_LONG_EDGE)
    _save_jpeg(preview_img, preview_path, PREVIEW_QUALITY)

    grid_img = _resize_long_edge(preview_img, GRID_LONG_EDGE)
    _save_jpeg(grid_img, grid_path, GRID_QUALITY)

    return ThumbnailPaths(grid=grid_path, preview=preview_path)


async def generate_thumbnails(
    source: Path, photo_id: str, cache_root: Path,
) -> ThumbnailPaths:
    """Async wrapper — runs decode + resize + save in a thread pool."""
    return await asyncio.to_thread(_generate_pair_sync, source, photo_id, cache_root)


async def ensure_thumbnails_for_photo(
    db: Database,
    photo_id: str,
    cache_root: Path,
    *,
    force: bool = False,
) -> ThumbnailPaths | None:
    """Ensure thumbnails exist for the given photo (build if missing, update photos table).

    Args:
        photo_id: photos.id
        cache_root: ~/.plumelens/cache/thumbnails/（内部会分 grid/ 和 preview/）
        force: True → 即使 photos.thumb_grid 已存在也重建

    Returns:
        ThumbnailPaths if built or already present; None if the source file is missing.
    """
    async with db.conn.execute(
        "SELECT file_path, thumb_grid, thumb_preview FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        msg = f"Photo not found: {photo_id}"
        raise RuntimeError(msg)

    source = Path(str(row["file_path"]))
    grid_rel = row["thumb_grid"]
    preview_rel = row["thumb_preview"]

    if not force and grid_rel and preview_rel:
        grid_p = cache_root / str(grid_rel)
        preview_p = cache_root / str(preview_rel)
        if grid_p.exists() and preview_p.exists():
            return ThumbnailPaths(grid=grid_p, preview=preview_p)

    if not source.exists():  # noqa: ASYNC240
        logger.warning("Source missing, cannot build thumbnails", photo_id=photo_id)
        return None

    paths = await generate_thumbnails(source, photo_id, cache_root)

    # 存相对路径（便于 cache_root 整体迁移）
    grid_rel_str = f"grid/{photo_id}.jpg"
    preview_rel_str = f"preview/{photo_id}.jpg"
    await db.conn.execute(
        "UPDATE photos SET thumb_grid = ?, thumb_preview = ? WHERE id = ?",
        (grid_rel_str, preview_rel_str, photo_id),
    )
    await db.conn.commit()

    await logger.ainfo(
        "Thumbnails generated",
        photo_id=photo_id,
        grid=str(paths.grid),
        preview=str(paths.preview),
    )
    return paths


async def generate_library_thumbnails(
    db: Database,
    library_id: str,
    cache_root: Path,
    *,
    concurrency: int = 4,
) -> dict[str, int]:
    """Build thumbnails for all photos in a library that don't have them yet.

    Returns:
        {"built": N, "skipped": M, "failed": K}
    """
    async with db.conn.execute(
        "SELECT id FROM photos WHERE library_id = ? AND "
        "(thumb_grid IS NULL OR thumb_preview IS NULL)",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()
    photo_ids = [str(r["id"]) for r in rows]

    built = 0
    failed = 0
    sem = asyncio.Semaphore(concurrency)

    async def _one(pid: str) -> bool:
        async with sem:
            try:
                result = await ensure_thumbnails_for_photo(db, pid, cache_root)
                return result is not None
            except Exception as e:
                logger.warning("Thumbnail failed", photo_id=pid, error=str(e))
                return False

    outcomes = await asyncio.gather(*[_one(pid) for pid in photo_ids])
    for ok in outcomes:
        if ok:
            built += 1
        else:
            failed += 1

    return {"built": built, "skipped": 0, "failed": failed}
