# pyright: basic
"""场景分组服务 — 顺序扫 library 的 photos，逐对计算相似度，写 scene_id。

设计：
- 用 preview 缩略图（1920px）做相似度（不重新解码原 RAW，省 IO/decode）
- 顺序遍历（按 file_mtime / shot_at 升序）
- 每对相邻 photo 调 compute_similarity → 相似 → 沿用 scene_id；不相似 → +1

性能（实测 783 张连拍样本）：
- AKAZE + cv2 单对计算 ~30-80ms（缩略图 1920×1280 @ 1600 maxDim）
- 783 张顺序计算约 30-60s
- 用 asyncio.to_thread 不阻塞事件循环，但 cv2 内部释放 GIL → 单线程串行即可

并发：每个 library 独立任务，library 之间可并行；单 library 内必须串行（依赖前一张）。
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import structlog

from engine.core.database import Database
from engine.pipeline.scene_grouping import (
    SimilarityResult,
    compute_similarity,
    load_image_for_similarity,
)

logger = structlog.stdlib.get_logger()

# 场景组(scene)表达一次连续拍摄事件 / 同一观察上下文；连拍堆叠(stack)
# 则在场景内部由前端再按主体几何连续性拆分。这里不能把每个构图微动都切成
# scene，否则同一次飞版会碎成多个 2 张小组。
RAPID_CONTINUITY_MAX_GAP_SECONDS = 2.0
RAPID_FEATURE_CONFIDENCE_MIN = 0.80
RAPID_FEATURE_SIMILARITY_THRESHOLD = 0.03
RAPID_COLOR_SIMILARITY_THRESHOLD = 0.78


def _resolve_preview_path(thumb_preview: str | None, cache_root: Path) -> Path | None:
    """thumb_preview 是相对路径 'preview/{photo_id}.jpg' → 绝对磁盘路径。"""
    if not thumb_preview:
        return None
    p = cache_root / thumb_preview
    return p if p.exists() else None


def _parse_sort_timestamp(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, int | float):
        ts = float(value)
        return ts if math.isfinite(ts) else None
    text = str(value).strip()
    if not text:
        return None
    try:
        numeric_ts = float(text)
    except ValueError:
        numeric_ts = None
    if numeric_ts is not None and math.isfinite(numeric_ts):
        return numeric_ts
    # EXIF DateTimeOriginal: "YYYY:MM:DD HH:MM:SS"; ISO strings from DB are already valid.
    if len(text) >= 19 and text[4] == ":" and text[7] == ":":
        text = text.replace(":", "-", 2).replace(" ", "T", 1)
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


def _shot_sort_timestamp(row: Any) -> float:
    """排序优先级: EXIF DateTimeOriginal > file_mtime > created_at."""
    try:
        raw_exif = row["exif_json"]
        if raw_exif:
            exif = json.loads(str(raw_exif))
            if isinstance(exif, dict):
                dto_ts = _parse_sort_timestamp(exif.get("DateTimeOriginal"))
                if dto_ts is not None:
                    return dto_ts
    except Exception:
        pass

    for key in ("file_mtime", "created_at"):
        try:
            ts = _parse_sort_timestamp(row[key])
            if ts is not None:
                return ts
        except Exception:
            continue
    return 0.0


def _natural_sort_key(value: object) -> tuple[tuple[int, int | str], ...]:
    """文件名自然序：5Y3A9919.JPG < 5Y3A9920.JPG。

    EXIF DateTimeOriginal 只有秒级精度；高速连拍同一秒内可有多张照片。
    之前同秒照片用 UUID 打散顺序，会把连续飞版随机切碎。
    """
    parts = re.split(r"(\d+)", str(value or ""))
    key: list[tuple[int, int | str]] = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            key.append((0, int(part)))
        else:
            key.append((1, part.lower()))
    return tuple(key)


def _shot_sort_key(row: Any) -> tuple[float, float, tuple[tuple[int, int | str], ...], str]:
    """稳定拍摄顺序：EXIF 秒级时间 > 文件 mtime > 文件名自然序 > id。"""
    primary_ts = _shot_sort_timestamp(row)
    try:
        file_mtime_ts = _parse_sort_timestamp(row["file_mtime"])
    except Exception:
        file_mtime_ts = None
    try:
        file_name = row["file_name"]
    except Exception:
        file_name = ""
    try:
        photo_id = str(row["id"])
    except Exception:
        photo_id = ""
    return (
        primary_ts,
        file_mtime_ts if file_mtime_ts is not None else primary_ts,
        _natural_sort_key(file_name),
        photo_id,
    )


def _shot_gap_seconds(prev_row: Any, cur_row: Any) -> float | None:
    prev_ts = _shot_sort_timestamp(prev_row)
    cur_ts = _shot_sort_timestamp(cur_row)
    if prev_ts <= 0 or cur_ts <= 0:
        return None
    return max(0.0, cur_ts - prev_ts)


def _is_same_scene(sim: SimilarityResult, gap_seconds: float | None) -> bool:
    if sim.similar:
        return True
    if gap_seconds is None or gap_seconds > RAPID_CONTINUITY_MAX_GAP_SECONDS:
        return False

    # 高速连拍里的飞鸟常因主体位置/翅形变化让 AKAZE 从 0.05 掉到 0.03-0.05。
    # 这类边界仍应属于同一 scene；更细的候选拆分交给连拍堆叠处理。
    if (
        sim.feature_confidence >= RAPID_FEATURE_CONFIDENCE_MIN
        and sim.feature_similarity >= RAPID_FEATURE_SIMILARITY_THRESHOLD
    ):
        return True
    return bool(
        sim.color_similarity >= 0
        and sim.color_similarity >= RAPID_COLOR_SIMILARITY_THRESHOLD
    )


def _compute_pair_sync(prev_path: Path, cur_path: Path) -> SimilarityResult | None:
    """同步计算两张图的相似度（运行在 to_thread）。"""
    img_prev = load_image_for_similarity(prev_path)
    img_cur = load_image_for_similarity(cur_path)
    if img_prev is None or img_cur is None:
        # 加载失败 → 保守起见标为不相似（开新场景）
        return None
    return compute_similarity(img_prev, img_cur)


async def regroup_library(
    db: Database,
    library_id: str,
    cache_root: Path,
) -> dict[str, int]:
    """对 library 内所有 photos 重新分配 scene_id。

    Returns: {"scanned": N, "scenes": M, "skipped": K}
        scanned: 处理的 photo 数
        scenes: 生成的场景数（distinct scene_id 数）
        skipped: 缩略图缺失/加载失败被跳过的对数
    """
    # 取所有 photo，优先按 EXIF DateTimeOriginal 排序；缺失时回退 file_mtime。
    async with db.conn.execute(
        "SELECT id, file_name, thumb_preview, file_mtime, created_at, exif_json "
        "FROM photos WHERE library_id = ? ",
        (library_id,),
    ) as cur:
        rows = sorted(
            await cur.fetchall(),
            key=_shot_sort_key,
        )

    if not rows:
        return {"scanned": 0, "scenes": 0, "skipped": 0}

    scene_id = 0
    skipped = 0
    prev_path: Path | None = None
    prev_row: Any | None = None
    updates: list[tuple[int, str]] = []  # (scene_id, photo_id)

    for row in rows:
        photo_id = str(row["id"])
        cur_path = _resolve_preview_path(
            str(row["thumb_preview"]) if row["thumb_preview"] else None,
            cache_root,
        )

        if prev_path is None:
            # 第一张，或前面都还没有可用缩略图：只能作为当前场景的起点。
            updates.append((scene_id, photo_id))
        elif cur_path is None:
            skipped += 1
            # 没法判定相似度时沿用前一场景（连拍中间一张缩略图丢了也算同一场景）。
            # 这是经验权衡：宁可少切，也别因为缓存缺口把同一段连拍错切成多个场景。
            updates.append((scene_id, photo_id))
        else:
            # 跑相似度（cv2 在 thread pool）
            try:
                sim = await asyncio.to_thread(_compute_pair_sync, prev_path, cur_path)
            except Exception as e:
                logger.warning(
                    "scene similarity exception",
                    library_id=library_id,
                    photo_id=photo_id,
                    error=str(e),
                )
                sim = None
            if sim is None:
                similar = False
            else:
                similar = _is_same_scene(sim, _shot_gap_seconds(prev_row, row))
            if not similar:
                scene_id += 1
            updates.append((scene_id, photo_id))

        if cur_path is not None:
            prev_path = cur_path
            prev_row = row

    # 批量写回 scene_id（一次事务）
    await db.conn.executemany(
        "UPDATE photos SET scene_id = ? WHERE id = ?",
        updates,
    )
    await db.conn.commit()

    scenes = scene_id + 1
    await logger.ainfo(
        "Library scene grouping completed",
        library_id=library_id,
        scanned=len(updates),
        scenes=scenes,
        skipped=skipped,
    )
    return {"scanned": len(updates), "scenes": scenes, "skipped": skipped}
