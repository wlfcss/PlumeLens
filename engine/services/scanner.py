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
                #
                # ⚠ 坐标系：Canon AFInfo 用相机 sensor 帧坐标（0,0=sensor 中心，
                # 与 EXIF Orientation 无关）。但 PlumeLens 其他链路用 post-rotation
                # 显示坐标。所以必须传 sensor 维度（pre-rotation 的原始 width/height）
                # 给 _parse_canon_afinfo2，再按 orientation 把结果转换到显示坐标系。
                try:
                    make = str(exif_dict.get("Make", "")).lower()
                    if "canon" in make:
                        raw_exif = img.getexif()
                        # MakerNote 位于 ExifIFD，不在 IFD0；Pillow 的顶层
                        # getexif().get(0x927C) 对 Canon R 系列 JPEG 会拿不到。
                        exif_ifd = raw_exif.get_ifd(ExifTags.IFD.Exif)
                        mn = exif_ifd.get(0x927C)  # MakerNote tag
                        if isinstance(mn, bytes) and meta.get("width") and meta.get("height"):
                            maker_note_tiff_offset = _find_jpeg_makernote_tiff_offset(path, mn)
                            # sensor 维度（与 PIL.Image.open(path).width/height 一致 —
                            # 即 pre-rotation 维度。orientation ∈ {5,6,7,8} 时和
                            # meta['width']/['height'] 不同；否则一致。
                            sensor_w = img.width
                            sensor_h = img.height
                            af = _parse_canon_afinfo2(
                                mn,
                                int(sensor_w),
                                int(sensor_h),
                                maker_note_tiff_offset,
                            )
                            if af is not None:
                                # 把 sensor 坐标系 AF 结构转换到 post-rotation 显示坐标系
                                # （与 bbox/keypoints 一致）。保留 af_point 兼容旧前端；
                                # 新前端使用 af_area，避免把区域 AF 错画成单个点。
                                af = _rotate_af_area_to_display(
                                    af,
                                    sensor_w,
                                    sensor_h,
                                    int(orientation),
                                )
                                exif_dict["af_area"] = af
                                exif_dict["af_point"] = af["center"]
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

    # IFD0：基础元数据（Make/Model/Orientation/DateTime）
    for tag_id, value in exif.items():
        tag_name = tag_map.get(tag_id, str(tag_id))
        # GPSInfo 在 IFD0 里通常只是一个 offset，真正内容必须用 GPS IFD 展开。
        if tag_name in _EXIF_WHITELIST and tag_name != "GPSInfo":
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

    # GPS IFD：Pillow 的 IFD0 GPSInfo 常是偏移量，不主动 get_ifd 会导致真实照片
    # 只有一个数字 offset，前端地图自然解析不到经纬度。
    try:
        gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
        gps: dict[str, Any] = {}
        for tag_id, value in gps_ifd.items():
            tag_name = ExifTags.GPSTAGS.get(tag_id, str(tag_id))
            gps[tag_name] = _jsonify(value)
            # 同时保留数字 tag 字符串，兼容部分旧前端/测试数据路径。
            gps[str(tag_id)] = _jsonify(value)
        if gps:
            out["GPSInfo"] = gps
    except Exception:
        pass

    return out


def _rotate_af_point_to_display(
    x: float,
    y: float,
    sensor_w: int,
    sensor_h: int,
    orientation: int,
) -> dict[str, float]:
    """把 sensor 坐标系的 (x, y) 按 EXIF Orientation 转换到 post-rotation 显示坐标系。

    必须与 PIL.ImageOps.exif_transpose / preprocess._load_pillow / _load_raw 的
    旋转逻辑一致（同向旋转 + 同向翻转）。

    EXIF Orientation 定义（行业标准）：
      1 = normal
      2 = mirror horizontal
      3 = rotate 180°
      4 = mirror vertical
      5 = mirror horizontal + rotate 90° CW
      6 = rotate 90° CW
      7 = mirror horizontal + rotate 90° CCW (=270° CW)
      8 = rotate 90° CCW

    Args:
        x, y: AF 点在 sensor 坐标系的像素坐标（0,0 = sensor 左上）
        sensor_w, sensor_h: sensor 帧的宽高（pre-rotation）
        orientation: EXIF Orientation 值（1-8）

    Returns:
        {"x": float, "y": float} 在 post-rotation 显示坐标系的像素坐标
    """
    # 公式参考：PIL.ImageOps.exif_transpose 对应的 PIL.Image.Transpose 操作。
    # 摄影场景下相机几乎只产生 1/3/6/8（landscape / 倒置 / portrait CCW / portrait CW），
    # 5/7 极罕见但仍要正确。
    if orientation == 1:
        # normal
        return {"x": x, "y": y}
    if orientation == 2:
        # FLIP_LEFT_RIGHT: (x, y) → (W - x, y)
        return {"x": float(sensor_w) - x, "y": y}
    if orientation == 3:
        # ROTATE_180: (x, y) → (W - x, H - y)
        return {"x": float(sensor_w) - x, "y": float(sensor_h) - y}
    if orientation == 4:
        # FLIP_TOP_BOTTOM: (x, y) → (x, H - y)
        return {"x": x, "y": float(sensor_h) - y}
    if orientation == 5:
        # TRANSPOSE: (x, y) → (y, x)
        return {"x": y, "y": x}
    if orientation == 6:
        # ROTATE_270 (= 90° CW): (x, y) → (H - y, x); display 宽高 = (H, W)
        return {"x": float(sensor_h) - y, "y": x}
    if orientation == 7:
        # TRANSVERSE: (x, y) → (H - y, W - x)
        return {"x": float(sensor_h) - y, "y": float(sensor_w) - x}
    if orientation == 8:
        # ROTATE_90 (= 90° CCW): (x, y) → (y, W - x); display 宽高 = (H, W)
        return {"x": y, "y": float(sensor_w) - x}
    return {"x": x, "y": y}  # unknown orientation, leave unchanged


def _rotate_af_rect_to_display(
    rect: dict[str, float],
    sensor_w: int,
    sensor_h: int,
    orientation: int,
) -> dict[str, float]:
    """Rotate a sensor-coordinate AF rectangle into display coordinates."""
    corners = [
        _rotate_af_point_to_display(rect["x1"], rect["y1"], sensor_w, sensor_h, orientation),
        _rotate_af_point_to_display(rect["x2"], rect["y1"], sensor_w, sensor_h, orientation),
        _rotate_af_point_to_display(rect["x2"], rect["y2"], sensor_w, sensor_h, orientation),
        _rotate_af_point_to_display(rect["x1"], rect["y2"], sensor_w, sensor_h, orientation),
    ]
    xs = [point["x"] for point in corners]
    ys = [point["y"] for point in corners]
    return {"x1": min(xs), "y1": min(ys), "x2": max(xs), "y2": max(ys)}


def _rotate_af_area_to_display(
    area: dict[str, Any],
    sensor_w: int,
    sensor_h: int,
    orientation: int,
) -> dict[str, Any]:
    """Rotate structured Canon AF area metadata into display coordinates."""

    def rotate_point(point: dict[str, Any]) -> dict[str, Any]:
        rotated = _rotate_af_point_to_display(
            float(point["x"]),
            float(point["y"]),
            sensor_w,
            sensor_h,
            orientation,
        )
        result = {**point, **rotated}
        bounds = point.get("bounds")
        if isinstance(bounds, dict):
            result["bounds"] = _rotate_af_rect_to_display(bounds, sensor_w, sensor_h, orientation)
        return result

    result = {**area}
    result["center"] = _rotate_af_point_to_display(
        float(area["center"]["x"]),
        float(area["center"]["y"]),
        sensor_w,
        sensor_h,
        orientation,
    )
    if isinstance(area.get("bounds"), dict):
        result["bounds"] = _rotate_af_rect_to_display(
            area["bounds"],
            sensor_w,
            sensor_h,
            orientation,
        )
    result["points"] = [rotate_point(point) for point in area.get("points", [])]
    result["focused_points"] = [rotate_point(point) for point in area.get("focused_points", [])]
    result["selected_points"] = [rotate_point(point) for point in area.get("selected_points", [])]
    return result


def _find_jpeg_makernote_tiff_offset(path: Path, makernote_bytes: bytes) -> int | None:
    """Find MakerNote's offset relative to the EXIF TIFF header in a JPEG.

    Canon MakerNote IFD entry value offsets are TIFF-relative. Pillow returns
    only the MakerNote byte payload, so we need this base offset to slice
    nested entries such as AFInfo2 correctly.
    """
    if path.suffix.lower() not in {".jpg", ".jpeg"} or len(makernote_bytes) < 16:
        return None

    try:
        with path.open("rb") as f:
            if f.read(2) != b"\xff\xd8":
                return None
            while True:
                prefix = f.read(1)
                if not prefix:
                    return None
                if prefix != b"\xff":
                    continue

                marker = f.read(1)
                while marker == b"\xff":
                    marker = f.read(1)
                if not marker:
                    return None
                marker_code = marker[0]

                # SOS/EOI: compressed image data starts, EXIF segments are over.
                if marker_code in {0xDA, 0xD9}:
                    return None
                # Standalone markers have no segment length.
                if marker_code == 0x01 or 0xD0 <= marker_code <= 0xD7:
                    continue

                length_bytes = f.read(2)
                if len(length_bytes) != 2:
                    return None
                segment_len = int.from_bytes(length_bytes, "big")
                payload_len = segment_len - 2
                if payload_len <= 0:
                    return None

                if marker_code != 0xE1:
                    f.seek(payload_len, 1)
                    continue

                payload = f.read(payload_len)
                exif_header = payload.find(b"Exif\x00\x00")
                if exif_header < 0:
                    continue
                tiff_start = exif_header + len(b"Exif\x00\x00")

                maker_start = payload.find(makernote_bytes, tiff_start)
                if maker_start < 0:
                    # A small fallback for files where Pillow normalizes trailing bytes.
                    prefix_len = min(256, len(makernote_bytes))
                    maker_start = payload.find(makernote_bytes[:prefix_len], tiff_start)
                if maker_start < 0:
                    return None
                return maker_start - tiff_start
    except Exception:
        return None


def _parse_canon_afinfo2(
    makernote_bytes: bytes,
    image_width: int,
    image_height: int,
    makernote_tiff_offset: int | None = None,
) -> dict[str, Any] | None:
    """Parse Canon AFInfo2 (MakerNote tag 0x0026), return AF area in image coords.

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

    返回结构化 AF 信息：selected AF area、in-focus AF points、区域 bounds 和中心点。
    这样前端可以按 Canon 官方 AF area 语义区分单点、扩展区域和 Zone/Whole area，
    而不是把所有对焦模式错误压成一个几何中心。

    Returns:
        AF area dict in image pixels, or None if parse fails.
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
                    "<I",
                    makernote_bytes,
                    entry_off + 8,
                )[0]
                afinfo2_offset = value_or_offset
                afinfo2_count = count
                break

        if afinfo2_offset is None or afinfo2_count is None:
            return None

        candidate_offsets: list[int] = []
        if makernote_tiff_offset is not None:
            candidate_offsets.append(afinfo2_offset - makernote_tiff_offset)
        candidate_offsets.append(afinfo2_offset)

        for rel_offset in dict.fromkeys(candidate_offsets):
            if rel_offset < 0:
                continue
            end_byte = rel_offset + afinfo2_count * 2
            if end_byte > len(makernote_bytes):
                continue
            parsed = _parse_canon_afinfo2_data(
                makernote_bytes[rel_offset:end_byte],
                image_width,
                image_height,
            )
            if parsed is not None:
                return parsed
        return None
    except Exception:
        return None


def _parse_canon_afinfo2_data(
    data: bytes,
    image_width: int,
    image_height: int,
) -> dict[str, Any] | None:
    """Parse the Canon AFInfo2 value payload after its IFD offset is resolved."""
    import struct

    try:
        # 头部 6 个 uint16
        if len(data) < 12:
            return None
        _af_info_size, af_area_mode, num_points, _valid_points, af_w, af_h = struct.unpack_from(
            "<6H", data, 0
        )
        if num_points == 0 or num_points > 4096 or af_w == 0 or af_h == 0:
            return None

        # 计算各数组所在偏移
        cur = 12
        if cur + num_points * 2 > len(data):
            return None
        area_widths = struct.unpack_from(f"<{num_points}h", data, cur)
        cur += num_points * 2
        if cur + num_points * 2 > len(data):
            return None
        area_heights = struct.unpack_from(f"<{num_points}h", data, cur)
        cur += num_points * 2
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

        def bit_indices(bits: tuple[int, ...]) -> list[int]:
            indices: list[int] = []
            for index in range(num_points):
                if (bits[index // 16] >> (index % 16)) & 1:
                    indices.append(index)
            return indices

        focused = bit_indices(in_focus_bits)
        selected: list[int] = []
        if cur + bitmask_words * 2 <= len(data):
            selected_bits = struct.unpack_from(f"<{bitmask_words}H", data, cur)
            selected = bit_indices(selected_bits)

        active = sorted(set(focused or selected))
        if not active:
            return None

        scale_x = image_width / af_w
        scale_y = image_height / af_h

        def point_payload(index: int) -> dict[str, Any]:
            image_x = (x_positions[index] + af_w / 2.0) * scale_x
            image_y = (y_positions[index] + af_h / 2.0) * scale_y
            point_w = abs(area_widths[index]) * scale_x
            point_h = abs(area_heights[index]) * scale_y
            bounds = {
                "x1": max(0.0, image_x - point_w / 2.0),
                "y1": max(0.0, image_y - point_h / 2.0),
                "x2": min(float(image_width), image_x + point_w / 2.0),
                "y2": min(float(image_height), image_y + point_h / 2.0),
            }
            return {
                "index": index,
                "x": float(image_x),
                "y": float(image_y),
                "width": float(point_w),
                "height": float(point_h),
                "bounds": bounds,
                "in_focus": index in focused,
                "selected": index in selected,
            }

        def build_points(indices: list[int], cap: int = 96) -> list[dict[str, Any]]:
            return [point_payload(index) for index in indices[:cap]]

        def bounds_for(indices: list[int]) -> dict[str, float] | None:
            if not indices:
                return None
            points = [point_payload(index) for index in indices]
            return {
                "x1": min(point["bounds"]["x1"] for point in points),
                "y1": min(point["bounds"]["y1"] for point in points),
                "x2": max(point["bounds"]["x2"] for point in points),
                "y2": max(point["bounds"]["y2"] for point in points),
            }

        bounds = bounds_for(selected) or bounds_for(focused)
        if bounds is None:
            return None

        center = {
            "x": (bounds["x1"] + bounds["x2"]) / 2.0,
            "y": (bounds["y1"] + bounds["y2"]) / 2.0,
        }

        if not (0 <= center["x"] <= image_width and 0 <= center["y"] <= image_height):
            return None

        selected_count = len(selected)
        focused_count = len(focused)
        bounds_w = bounds["x2"] - bounds["x1"]
        bounds_h = bounds["y2"] - bounds["y1"]
        if selected_count <= 1 and focused_count <= 1:
            kind = "point"
        elif max(selected_count, focused_count) <= 9 and bounds_w < image_width * 0.35:
            kind = "expanded"
        elif bounds_w >= image_width * 0.75 and bounds_h >= image_height * 0.75:
            kind = "whole_area"
        else:
            kind = "zone"

        return {
            "provider": "canon_afinfo2",
            "mode": int(af_area_mode),
            "kind": kind,
            "source": "in_focus" if focused else "selected",
            "center": center,
            "bounds": bounds,
            "points": build_points(active),
            "focused_points": build_points(focused),
            "selected_points": build_points(selected),
            "focused_count": focused_count,
            "selected_count": selected_count,
            "point_count": len(active),
        }
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
    batch_size: int = 50,
) -> dict[str, int]:
    """重新抽取 library 内"EXIF 不完整"的照片的 EXIF。

    判定"不完整"：exif_json IS NULL，或解析后既没 FNumber 也没 ExposureTime
    （这两个 ExifIFD 字段是 5deab5f 之前老扫描遗漏的标志），或 Canon
    照片还没有结构化 af_area（旧版本只保存 af_point，无法区分单点/区域 AF）。

    用于：升级到 5deab5f 之后，DB 里残留的旧 exif_json 缺曝光参数 — 启动后台
    自动重抽，不要求用户手动操作。

    Returns:
        {"refreshed": N, "skipped": M, "failed": K}
    """
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
        if "FNumber" not in d or "ExposureTime" not in d:
            return True
        make = str(d.get("Make", "")).lower()
        return "canon" in make and not isinstance(d.get("af_area"), dict)

    last_rowid = 0
    while True:
        async with db.conn.execute(
            "SELECT rowid AS scan_rowid, id, file_path, exif_json "
            "FROM photos WHERE library_id = ? AND rowid > ? "
            "ORDER BY rowid LIMIT ?",
            (library_id, last_rowid, batch_size),
        ) as cur:
            rows = await cur.fetchall()
        if not rows:
            break

        batch_refreshed = 0
        for row in rows:
            last_rowid = int(row["scan_rowid"])
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
                refreshed += 1
                batch_refreshed += 1
            except Exception as e:
                logger.warning("EXIF refresh failed", photo_id=photo_id, error=str(e))
                failed += 1

        if batch_refreshed > 0:
            await db.conn.commit()

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


class _CompanionInfo:
    """同伴文件元数据(scanner 内部用,不暴露给 service 外)。"""

    __slots__ = ("path", "format", "size")

    def __init__(self, path: Path, fmt: str, size: int) -> None:
        self.path = path
        self.format = fmt
        self.size = size


def _resolve_pairs(
    files: list[Path],
) -> tuple[list[Path], dict[str, _CompanionInfo | None]]:
    """识别 (目录, stem) 同名的 IMAGE+RAW pair,返回 (主 entry 列表, 主路径→同伴 map)。

    规则:
    - 同 (parent, stem.lower()) 下,恰好 1 个 IMAGE_EXTENSIONS + 1 个 RAW_EXTENSIONS:
      → IMAGE 作主 entry,RAW 作 companion(用户偏好 JPG 跑管线快)。
    - 同 stem 多 IMAGE 或多 RAW(罕见,可能用户有 small.jpg + IMG.jpg + IMG.cr3):
      → 不识别 pair,所有文件各自独立 INSERT(保持现有行为,避免误吞用户文件)。
    - 同 stem 仅 IMAGE 或仅 RAW: → 该文件独立,无 companion。

    主 entry 列表保持稳定排序(便于 scan_library 顺序消费)。同伴 map 的 key 是主
    entry 的字符串路径,value 为 None 表示无同伴。
    """
    by_stem: dict[tuple[Path, str], list[Path]] = {}
    for p in files:
        key = (p.parent, p.stem.lower())
        by_stem.setdefault(key, []).append(p)

    primaries: list[Path] = []
    companions: dict[str, _CompanionInfo | None] = {}

    for paths in by_stem.values():
        images = [p for p in paths if p.suffix.lower() in IMAGE_EXTENSIONS]
        raws = [p for p in paths if p.suffix.lower() in RAW_EXTENSIONS]
        if len(images) == 1 and len(raws) == 1:
            # 明确 pair
            primary = images[0]
            raw = raws[0]
            try:
                raw_size = raw.stat().st_size
            except OSError:
                raw_size = 0
            primaries.append(primary)
            companions[str(primary)] = _CompanionInfo(
                path=raw,
                fmt=raw.suffix.lower().lstrip(".").upper(),
                size=raw_size,
            )
        else:
            # 不识别 pair,每个文件独立入库
            for p in paths:
                primaries.append(p)
                companions[str(p)] = None

    primaries.sort()
    return primaries, companions


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

    existing: dict[str, tuple[str, int, str, str | None]] = {}
    async with conn.execute(
        "SELECT id, file_path, file_size, file_mtime, companion_path "
        "FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        async for row in cur:
            existing[str(row["file_path"])] = (
                str(row["id"]),
                int(row["file_size"]),
                str(row["file_mtime"]),
                str(row["companion_path"]) if row["companion_path"] is not None else None,
            )

    raw_files = _walk_supported_files(root, recursive=recursive)
    files, companion_map = _resolve_pairs(raw_files)
    now = _now_iso()

    for path in files:
        try:
            size, mtime = _light_fingerprint(path)
        except Exception as e:
            report.errors.append((str(path), f"stat failed: {e}"))
            continue

        path_key = str(path)
        prev = existing.get(path_key)
        comp = companion_map.get(path_key)
        comp_path = str(comp.path) if comp else None
        comp_format = comp.format if comp else None
        comp_size = comp.size if comp else None

        if prev is None:
            meta = _probe_image_meta(path)
            photo_id = str(uuid.uuid4())
            try:
                await conn.execute(
                    "INSERT INTO photos (id, file_path, file_name, file_size, "
                    "file_mtime, format, width, height, exif_json, "
                    "companion_path, companion_format, companion_size, "
                    "created_at, library_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        photo_id,
                        path_key,
                        path.name,
                        size,
                        mtime,
                        _file_format(path),
                        meta.get("width"),
                        meta.get("height"),
                        meta.get("exif_json"),
                        comp_path,
                        comp_format,
                        comp_size,
                        now,
                        library_id,
                    ),
                )
                report.added += 1
            except Exception as e:
                report.errors.append((path_key, f"insert failed: {e}"))
        else:
            _prev_id, prev_size, prev_mtime, prev_comp = prev
            file_unchanged = prev_size == size and prev_mtime == mtime
            companion_unchanged = prev_comp == comp_path
            if file_unchanged and companion_unchanged:
                report.unchanged += 1
                continue
            # 主文件变了 → 重读 meta + 清 hash;否则只更新 companion 字段
            if not file_unchanged:
                meta = _probe_image_meta(path)
                try:
                    await conn.execute(
                        "UPDATE photos SET file_size = ?, file_mtime = ?, "
                        "file_hash = NULL, width = ?, height = ?, exif_json = ?, "
                        "companion_path = ?, companion_format = ?, companion_size = ? "
                        "WHERE file_path = ?",
                        (
                            size,
                            mtime,
                            meta.get("width"),
                            meta.get("height"),
                            meta.get("exif_json"),
                            comp_path,
                            comp_format,
                            comp_size,
                            path_key,
                        ),
                    )
                    report.updated += 1
                except Exception as e:
                    report.errors.append((path_key, f"update failed: {e}"))
            else:
                # 仅 companion 变化(用户后导入 RAW / 删了 RAW)→ 不重读 meta、不清 hash
                try:
                    await conn.execute(
                        "UPDATE photos SET companion_path = ?, companion_format = ?, "
                        "companion_size = ? WHERE file_path = ?",
                        (comp_path, comp_format, comp_size, path_key),
                    )
                    report.updated += 1
                except Exception as e:
                    report.errors.append((path_key, f"companion update failed: {e}"))

    await conn.commit()
    # 入库后增量做一次 companion 反向清理:之前是 pair 主 entry、现在 RAW 同伴消失
    # → companion_* 应清掉。本轮 scan 已经把仍然存在的 pair 写对了,但如果用户刚
    # 删掉某个 RAW,主 JPG 的 file size/mtime 没变 → file_unchanged=true,但 companion
    # 也没变化(prev_comp=path, comp=path)→ companion_unchanged=true → 不会进 UPDATE。
    # 这里用 fs ground truth 兜底:对所有处理过的 path,如果 companion_map 是 None
    # 但 DB 里 companion_path 还指向已不存在的文件,清掉。
    paths_with_no_companion = [
        p for p, c in companion_map.items() if c is None and p in existing
    ]
    if paths_with_no_companion:
        for path_key in paths_with_no_companion:
            prev = existing.get(path_key)
            if prev and prev[3] is not None:
                # DB 里有 companion_path,但本轮 fs 扫描下这个 path 不再 pair → 清掉
                await conn.execute(
                    "UPDATE photos SET companion_path = NULL, companion_format = NULL, "
                    "companion_size = NULL WHERE file_path = ?",
                    (path_key,),
                )
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


async def backfill_companion_for_library(db: Database, library_id: str) -> int:
    """v6 → v7 升级后老库的 companion_* 字段补全(轻量,只 stat 不读 EXIF)。

    思路:把老库 photos 表中所有 file_path 拿出来,按 (parent, stem) 重新分组识别 pair,
    给主 entry 写 companion_*。本函数不入新行(只更新老 photos),也不删孤儿 RAW
    photo(老库可能 RAW + JPG 都各自入库了 — 删 RAW photo 会丢用户的决策/物种标注)。

    适合在 lifespan 启动时跑一次。后续正常 scan_library 会自动维护。

    Returns: 成功更新 companion 字段的 photo 行数。
    """
    conn = db.conn
    async with conn.execute(
        "SELECT file_path, companion_path FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    paths = [Path(str(r["file_path"])) for r in rows]
    existing_companion = {str(r["file_path"]): r["companion_path"] for r in rows}
    if not paths:
        return 0

    # 仅把 fs 上仍存在的 file 纳入 pair 识别(消失文件不参与,避免错误关联)
    alive_paths = [p for p in paths if p.exists()]
    _primaries, companion_map = _resolve_pairs(alive_paths)

    updated = 0
    for path_str, comp in companion_map.items():
        prev = existing_companion.get(path_str)
        new_comp_path = str(comp.path) if comp else None
        if prev == new_comp_path:
            continue
        new_format = comp.format if comp else None
        new_size = comp.size if comp else None
        await conn.execute(
            "UPDATE photos SET companion_path = ?, companion_format = ?, "
            "companion_size = ? WHERE file_path = ?",
            (new_comp_path, new_format, new_size, path_str),
        )
        updated += 1
    if updated > 0:
        await conn.commit()
        await logger.ainfo(
            "Companion backfill done",
            library_id=library_id,
            updated=updated,
        )
    return updated


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
                    "Hash failed",
                    photo_id=photo_id,
                    path=str(file_path),
                    error=str(e),
                )
                skipped_ids.add(photo_id)
                continue
            await conn.execute(
                "UPDATE photos SET file_hash = ? WHERE id = ?",
                (sha, photo_id),
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
