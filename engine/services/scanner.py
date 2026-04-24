# pyright: basic
"""Folder scanner: 两阶段文件系统遍历 + EXIF 读取 + 后台 SHA-256 补强。

阶段 1（light fingerprint）：path + size + mtime，快速建库可浏览
阶段 2（background hash）：逐张计算 SHA-256 写回 photos.file_hash，解锁分析

两阶段分离是产品级决策（见 PRODUCT_UX_PLAN §7 + TECHNICAL_SPEC §5.1）：
避免数千张 30-50MB RAW 全量哈希阻塞首次导入体验。
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from PIL import ExifTags, Image

from engine.core.database import Database
from engine.pipeline.preprocess import IMAGE_EXTENSIONS, RAW_EXTENSIONS, SUPPORTED_EXTENSIONS

logger = structlog.stdlib.get_logger()


# EXIF 中与摄影相关的关键字段（白名单，避免写入大量冗余字段）
_EXIF_WHITELIST: frozenset[str] = frozenset(
    {
        "Make",
        "Model",
        "LensModel",
        "LensMake",
        "DateTime",
        "DateTimeOriginal",
        "DateTimeDigitized",
        "ExposureTime",
        "FNumber",
        "ISOSpeedRatings",
        "FocalLength",
        "FocalLengthIn35mmFilm",
        "Orientation",
        "ExposureBiasValue",
        "MeteringMode",
        "Flash",
        "WhiteBalance",
        "GPSInfo",
    }
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _file_format(path: Path) -> str:
    """File extension (lowercased, without dot)."""
    return path.suffix.lower().lstrip(".")


def _probe_image_meta(path: Path) -> dict[str, Any]:
    """Read (width, height, exif) without loading full pixel data.

    RAW 文件通过 rawpy 的 sizes 读尺寸（不解码）；常规图走 Pillow。
    所有失败路径降级返回空 dict，不让扫描中断。
    """
    meta: dict[str, Any] = {}
    suffix = path.suffix.lower()

    if suffix in IMAGE_EXTENSIONS:
        try:
            with Image.open(path) as img:
                meta["width"] = img.width
                meta["height"] = img.height
                exif_dict = _extract_exif(img)
                if exif_dict:
                    meta["exif_json"] = json.dumps(exif_dict, ensure_ascii=False)
        except Exception as e:
            logger.warning("Failed to probe image", path=str(path), error=str(e))
    elif suffix in RAW_EXTENSIONS:
        try:
            import rawpy

            with rawpy.imread(str(path)) as raw:
                meta["width"] = int(raw.sizes.width)
                meta["height"] = int(raw.sizes.height)
            # 走 Pillow 读 EXIF（大多数 RAW 格式 Pillow 都能提 EXIF 段）
            try:
                with Image.open(path) as img:
                    exif_dict = _extract_exif(img)
                    if exif_dict:
                        meta["exif_json"] = json.dumps(exif_dict, ensure_ascii=False)
            except Exception:
                pass  # EXIF 读取失败不影响主流程
        except Exception as e:
            logger.warning("Failed to probe RAW", path=str(path), error=str(e))

    return meta


def _extract_exif(img: Image.Image) -> dict[str, Any]:
    """Extract whitelisted EXIF tags from a PIL image."""
    try:
        exif = img.getexif()
    except Exception:
        return {}
    if not exif:
        return {}
    tag_map = ExifTags.TAGS
    out: dict[str, Any] = {}
    for tag_id, value in exif.items():
        tag_name = tag_map.get(tag_id, str(tag_id))
        if tag_name not in _EXIF_WHITELIST:
            continue
        out[tag_name] = _jsonify(value)
    return out


def _jsonify(value: Any) -> Any:
    """Convert EXIF value to a JSON-serializable form."""
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace").strip("\x00")
        except Exception:
            return None
    if isinstance(value, (int, float, str, bool)) or value is None:
        return value
    # Pillow 的 IFDRational 有 numerator/denominator
    if hasattr(value, "numerator") and hasattr(value, "denominator"):
        try:
            denom = int(value.denominator)
            if denom == 0:
                return None
            return float(value.numerator) / denom
        except Exception:
            return str(value)
    if isinstance(value, (tuple, list)):
        return [_jsonify(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonify(v) for k, v in value.items()}
    return str(value)


def _light_fingerprint(path: Path) -> tuple[int, str]:
    """轻指纹：文件大小 + mtime。用于首扫快速建库。"""
    stat = path.stat()
    mtime = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
    return stat.st_size, mtime


def _sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute full SHA-256 of a file (streaming, 1MB chunks)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(chunk_size):
            h.update(chunk)
    return h.hexdigest()


def _walk_supported_files(root: Path, recursive: bool) -> list[Path]:
    """Enumerate supported image files under root."""
    pattern = "**/*" if recursive else "*"
    candidates = []
    for p in root.glob(pattern):
        if not p.is_file():
            continue
        if p.suffix.lower() in SUPPORTED_EXTENSIONS:
            candidates.append(p)
    return sorted(candidates)


class ScanReport:
    """Summary returned from `scan_library`."""

    def __init__(self) -> None:
        self.added: int = 0
        self.updated: int = 0
        self.unchanged: int = 0
        self.errors: list[tuple[str, str]] = []

    def to_dict(self) -> dict[str, Any]:
        return {
            "added": self.added,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "errors": self.errors,
        }


async def scan_library(
    db: Database,
    library_id: str,
    root: Path,
    recursive: bool = True,
) -> ScanReport:
    """Phase 1：轻指纹扫描，把文件系统状态同步到 photos 表。

    规则：
    - 新增文件（path 不在库）：INSERT 新 photo 行
    - 路径已存在 + (size, mtime) 变化：UPDATE（file_hash 清空，等待阶段 2 重算）
    - 路径已存在 + (size, mtime) 不变：跳过
    - 库中存在但文件系统已消失的 photo：不在本函数处理（由单独的清理流程）

    不做 SHA-256 计算，保证首扫体验。分析任务需等阶段 2 写入 file_hash。
    """
    report = ScanReport()
    conn = db.conn

    existing: dict[str, tuple[str, int, str]] = {}
    async with conn.execute(
        "SELECT id, file_path, file_size, file_mtime FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        async for row in cur:
            existing[str(row["file_path"])] = (
                str(row["id"]), int(row["file_size"]), str(row["file_mtime"]),
            )

    files = _walk_supported_files(root, recursive=recursive)
    now = _now_iso()

    for path in files:
        try:
            size, mtime = _light_fingerprint(path)
        except Exception as e:
            report.errors.append((str(path), f"stat failed: {e}"))
            continue

        path_key = str(path)
        prev = existing.get(path_key)

        if prev is None:
            meta = _probe_image_meta(path)
            photo_id = str(uuid.uuid4())
            try:
                await conn.execute(
                    "INSERT INTO photos (id, file_path, file_name, file_size, "
                    "file_mtime, format, width, height, exif_json, "
                    "created_at, library_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        photo_id, path_key, path.name, size, mtime,
                        _file_format(path),
                        meta.get("width"), meta.get("height"),
                        meta.get("exif_json"),
                        now, library_id,
                    ),
                )
                report.added += 1
            except Exception as e:
                report.errors.append((path_key, f"insert failed: {e}"))
        else:
            _prev_id, prev_size, prev_mtime = prev
            if prev_size == size and prev_mtime == mtime:
                report.unchanged += 1
                continue
            meta = _probe_image_meta(path)
            try:
                await conn.execute(
                    "UPDATE photos SET file_size = ?, file_mtime = ?, "
                    "file_hash = NULL, width = ?, height = ?, "
                    "exif_json = ? WHERE file_path = ?",
                    (size, mtime, meta.get("width"), meta.get("height"),
                     meta.get("exif_json"), path_key),
                )
                report.updated += 1
            except Exception as e:
                report.errors.append((path_key, f"update failed: {e}"))

    await conn.commit()
    await logger.ainfo(
        "Library scan completed",
        library_id=library_id,
        root=str(root),
        added=report.added,
        updated=report.updated,
        unchanged=report.unchanged,
        error_count=len(report.errors),
    )
    return report


async def backfill_hashes(db: Database, library_id: str, batch_size: int = 50) -> int:
    """Phase 2：为 file_hash 仍为 NULL 的照片计算 SHA-256 并写回。

    Args:
        batch_size: 每批处理多少张，每批一次 commit，便于进度可见

    Returns:
        本次调用新计算的哈希条数
    """
    conn = db.conn
    total = 0
    # 防死循环：本次调用内已尝试但跳过的 id 集合（文件消失 / 读取失败时进入）。
    # 数据库层仍保留 file_hash = NULL，由上层 missing 清理流程决定如何处理。
    skipped_ids: set[str] = set()
    while True:
        # 用 NOT IN 排除本次已跳过的 id；若没有跳过则等价于原查询
        if skipped_ids:
            placeholders = ",".join("?" * len(skipped_ids))
            query = (
                "SELECT id, file_path FROM photos "
                f"WHERE library_id = ? AND file_hash IS NULL AND id NOT IN ({placeholders}) "
                "LIMIT ?"
            )
            params: tuple = (library_id, *skipped_ids, batch_size)
        else:
            query = (
                "SELECT id, file_path FROM photos "
                "WHERE library_id = ? AND file_hash IS NULL "
                "LIMIT ?"
            )
            params = (library_id, batch_size)
        async with conn.execute(query, params) as cur:
            rows = await cur.fetchall()
        if not rows:
            break

        for row in rows:
            photo_id = str(row["id"])
            file_path = Path(str(row["file_path"]))
            try:
                sha = _sha256_file(file_path)
            except FileNotFoundError:
                skipped_ids.add(photo_id)
                continue
            except Exception as e:
                logger.warning(
                    "Hash failed", photo_id=photo_id, path=str(file_path), error=str(e),
                )
                skipped_ids.add(photo_id)
                continue
            await conn.execute(
                "UPDATE photos SET file_hash = ? WHERE id = ?", (sha, photo_id),
            )
            total += 1

        await conn.commit()

    await logger.ainfo(
        "Hash backfill completed",
        library_id=library_id,
        hashed=total,
        skipped=len(skipped_ids),
    )
    return total
