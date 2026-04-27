# pyright: basic
"""Folder scanner: 两阶段文件系统遍历 + EXIF 读取 + 后台 SHA-256 补强。

阶段 1（light fingerprint）：path + size + mtime，快速建库可浏览
阶段 2（background hash）：逐张计算 SHA-256 写回 photos.file_hash，解锁分析

两阶段分离是产品级决策（见 PRODUCT_UX_PLAN §7 + TECHNICAL_SPEC §5.1）：
避免数千张 30-50MB RAW 全量哈希阻塞首次导入体验。
"""

from __future__ import annotations

import asyncio
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
                # width/height 必须是"应用 EXIF Orientation 之后"的值（人眼看到的方向）。
                # 这样和 thumbnail（exif_transpose 过）+ inference（exif_transpose 过）
                # 保持一致；否则 bbox/姿态点 / af_point 在前端会偏移。
                orientation = (img.getexif() or {}).get(0x0112, 1)
                if orientation in (5, 6, 7, 8):
                    # 5/6/7/8 = 90°/270° 旋转 → 宽高对调
                    meta["width"] = img.height
                    meta["height"] = img.width
                else:
                    meta["width"] = img.width
                    meta["height"] = img.height
                exif_dict = _extract_exif(img)
                # 解析 Canon AFInfo MakerNote → 注入到 exif_json 的 af_point 字段
                # （前端从这里读取并渲染对焦点）
                # MakerNote 是通用 EXIF tag，但 0x0026 标签格式是 Canon 特有的；
                # 必须先检查 Make 是 Canon 才解析，否则其他品牌（Nikon/Sony）会错解。
                try:
                    make = str(exif_dict.get("Make", "")).lower()
                    if "canon" in make:
                        raw_exif = img.getexif()
                        mn = raw_exif.get(0x927C)  # MakerNote tag
                        if (
                            isinstance(mn, bytes)
                            and meta.get("width")
                            and meta.get("height")
                        ):
                            af = _parse_canon_afinfo2(
                                mn, int(meta["width"]), int(meta["height"]),
                            )
                            if af is not None:
                                exif_dict["af_point"] = af
                except Exception:
                    pass
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
    """Extract whitelisted EXIF tags from a PIL image.

    Camera-specific tags (ExposureTime/FNumber/ISO/LensModel/FocalLength) 在
    ExifIFD（0x8769）子目录里，不在 IFD0。必须 merge 两个 IFD 才能取全。
    """
    try:
        exif = img.getexif()
    except Exception:
        return {}
    if not exif:
        return {}

    tag_map = ExifTags.TAGS
    out: dict[str, Any] = {}

    # IFD0：基础元数据（Make/Model/Orientation/DateTime/GPSInfo）
    for tag_id, value in exif.items():
        tag_name = tag_map.get(tag_id, str(tag_id))
        if tag_name in _EXIF_WHITELIST:
            out[tag_name] = _jsonify(value)

    # ExifIFD：相机参数（ExposureTime/FNumber/ISO/LensModel/FocalLength/...）
    try:
        exif_ifd = exif.get_ifd(ExifTags.IFD.Exif)
        for tag_id, value in exif_ifd.items():
            tag_name = tag_map.get(tag_id, str(tag_id))
            if tag_name in _EXIF_WHITELIST:
                out[tag_name] = _jsonify(value)
    except Exception:
        pass  # ExifIFD 不存在或解析失败 → 忽略，IFD0 数据已足够

    return out


def _parse_canon_afinfo2(
    makernote_bytes: bytes,
    image_width: int,
    image_height: int,
) -> dict[str, float] | None:
    """Parse Canon AFInfo2 (MakerNote tag 0x0026), return AF point in image coords.

    Canon EOS R-series 把对焦点信息存在 MakerNote IFD 的 0x0026 (AFInfo2) 标签里。
    格式（all little-endian uint16/int16）：
        uint16  AFInfoSize
        uint16  AFAreaMode
        uint16  NumAFPoints       (总点数，通常 153/191/1053…)
        uint16  ValidAFPoints     (本次拍摄实际用了多少)
        uint16  AFImageWidth      (AF 坐标系的宽，用于换算到 image space)
        uint16  AFImageHeight
        int16[N] AFAreaWidths
        int16[N] AFAreaHeights
        int16[N] AFAreaXPositions  (signed，相对于图像中心)
        int16[N] AFAreaYPositions  (signed)
        uint16[(N+15)/16] AFPointsInFocus    (bitmask)
        uint16[(N+15)/16] AFPointsSelected   (bitmask)

    取 in-focus 点的几何中心，转换到原图像素坐标。

    Returns:
        {"x": float, "y": float} in image pixels, or None if parse fails.
    """
    import struct

    if not makernote_bytes or len(makernote_bytes) < 8:
        return None

    try:
        # MakerNote 是 TIFF IFD 格式：开头 2 字节 = 条目数
        num_entries = struct.unpack_from("<H", makernote_bytes, 0)[0]
        if num_entries > 1000:  # sanity cap
            return None

        afinfo2_offset: int | None = None
        afinfo2_count: int | None = None
        for i in range(num_entries):
            entry_off = 2 + i * 12
            if entry_off + 12 > len(makernote_bytes):
                return None
            tag, _type, count = struct.unpack_from("<HHI", makernote_bytes, entry_off)
            if tag == 0x0026:  # AFInfo2
                # value_or_offset 是 4 字节 — uint16 数组（type=3）超过 2 个就在 offset 处
                value_or_offset = struct.unpack_from(
                    "<I", makernote_bytes, entry_off + 8,
                )[0]
                afinfo2_offset = value_or_offset
                afinfo2_count = count
                break

        if afinfo2_offset is None or afinfo2_count is None:
            return None

        end_byte = afinfo2_offset + afinfo2_count * 2
        if end_byte > len(makernote_bytes):
            return None
        data = makernote_bytes[afinfo2_offset:end_byte]

        # 头部 6 个 uint16
        if len(data) < 12:
            return None
        _af_info_size, _af_area_mode, num_points, _valid_points, af_w, af_h = (
            struct.unpack_from("<6H", data, 0)
        )
        if num_points == 0 or num_points > 4096 or af_w == 0 or af_h == 0:
            return None

        # 计算各数组所在偏移
        cur = 12
        cur += num_points * 2  # widths
        cur += num_points * 2  # heights
        if cur + num_points * 2 > len(data):
            return None
        x_positions = struct.unpack_from(f"<{num_points}h", data, cur)
        cur += num_points * 2
        y_positions = struct.unpack_from(f"<{num_points}h", data, cur)
        cur += num_points * 2

        bitmask_words = (num_points + 15) // 16
        if cur + bitmask_words * 2 > len(data):
            return None
        in_focus_bits = struct.unpack_from(f"<{bitmask_words}H", data, cur)
        cur += bitmask_words * 2

        # 找 in-focus 的点
        focused: list[int] = []
        for i in range(num_points):
            if (in_focus_bits[i // 16] >> (i % 16)) & 1:
                focused.append(i)

        # 没有 in-focus 就退到 AFPointsSelected
        if not focused and cur + bitmask_words * 2 <= len(data):
            selected_bits = struct.unpack_from(f"<{bitmask_words}H", data, cur)
            for i in range(num_points):
                if (selected_bits[i // 16] >> (i % 16)) & 1:
                    focused.append(i)

        if not focused:
            return None

        avg_af_x = sum(x_positions[i] for i in focused) / len(focused)
        avg_af_y = sum(y_positions[i] for i in focused) / len(focused)

        # AF 坐标 (0,0) = 图像中心；x_positions/y_positions 是 signed center-relative
        # 映射到 image space：image_x = (af_x + af_w/2) * image_w / af_w
        image_x = (avg_af_x + af_w / 2.0) * image_width / af_w
        image_y = (avg_af_y + af_h / 2.0) * image_height / af_h

        # cap 到合理范围
        if not (0 <= image_x <= image_width and 0 <= image_y <= image_height):
            return None

        return {"x": float(image_x), "y": float(image_y)}
    except Exception:
        return None


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


async def refresh_library_exif(
    db: Database,
    library_id: str,
) -> dict[str, int]:
    """重新抽取 library 内"EXIF 不完整"的照片的 EXIF。

    判定"不完整"：exif_json IS NULL，或解析后既没 FNumber 也没 ExposureTime
    （这两个 ExifIFD 字段是 5deab5f 之前老扫描遗漏的标志）。

    用于：升级到 5deab5f 之后，DB 里残留的旧 exif_json 缺曝光参数 — 启动后台
    自动重抽，不要求用户手动操作。

    Returns:
        {"refreshed": N, "skipped": M, "failed": K}
    """
    # 1) 先查全库照片
    async with db.conn.execute(
        "SELECT id, file_path, exif_json FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    refreshed = 0
    skipped = 0
    failed = 0

    def _is_incomplete(raw: Any) -> bool:
        if raw is None:
            return True
        try:
            d = json.loads(str(raw))
        except Exception:
            return True
        if not isinstance(d, dict):
            return True
        # 关键字段任一缺失即判定为不完整（用 OR：缺 FNumber **或** 缺 ExposureTime）
        return "FNumber" not in d or "ExposureTime" not in d

    for row in rows:
        photo_id = str(row["id"])
        file_path = Path(str(row["file_path"]))
        if not _is_incomplete(row["exif_json"]):
            skipped += 1
            continue
        if not file_path.exists():  # noqa: ASYNC240
            # 文件丢了，跳过（path_missing 状态会由别处提示）
            failed += 1
            continue
        try:
            meta = await asyncio.to_thread(_probe_image_meta, file_path)
            new_exif = meta.get("exif_json")
            if new_exif is None:
                failed += 1
                continue
            await db.conn.execute(
                "UPDATE photos SET exif_json = ? WHERE id = ?",
                (new_exif, photo_id),
            )
            await db.conn.commit()
            refreshed += 1
        except Exception as e:
            logger.warning("EXIF refresh failed", photo_id=photo_id, error=str(e))
            failed += 1

    return {"refreshed": refreshed, "skipped": skipped, "failed": failed}


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
