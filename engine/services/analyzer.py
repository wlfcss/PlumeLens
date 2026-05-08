# pyright: basic
"""Analyzer: orchestrate pipeline invocation for a single photo.

Flow:
    photo_id → lookup photo row → check cache for pipeline_version
        ↓ miss
        run PipelineManager.analyze() → store_result()
        ↓
    return AnalysisOutcome (PipelineResult + "from_cache" flag)

Pipeline readiness 校验：analyzer 在 pipeline not ready 时抛 RuntimeError，
由 API 层转成 503。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import structlog

from engine.core.database import Database
from engine.pipeline.manager import PipelineManager
from engine.pipeline.models import BirdAnalysis, PipelineResult, PoseInfo
from engine.services.cache import get_result_for_version, store_result

logger = structlog.stdlib.get_logger()


@dataclass
class AnalysisOutcome:
    """Analyzer 返回值：结果 + 元信息（是否命中缓存）。"""

    result: PipelineResult
    from_cache: bool  # True: 命中历史缓存；False: 新跑 ONNX 推理


async def analyze_photo(
    db: Database,
    pipeline: PipelineManager,
    photo_id: str,
    *,
    force_rerun: bool = False,
) -> AnalysisOutcome:
    """Analyze one photo, using cache if available.

    Args:
        photo_id: photos 表主键
        force_rerun: True → 忽略缓存命中，强制重跑（"重新分析"）

    Raises:
        RuntimeError: 找不到 photo，或 pipeline 尚未就绪
        FileNotFoundError: photo.file_path 指向的文件不存在

    Returns:
        AnalysisOutcome（含 from_cache 标志）
    """
    if not pipeline.is_ready:
        msg = "Pipeline not ready; core models not loaded"
        raise RuntimeError(msg)

    async with db.conn.execute(
        "SELECT file_path, companion_path, width, height FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        msg = f"Photo not found: {photo_id}"
        raise RuntimeError(msg)
    file_path = Path(str(row["file_path"]))
    companion_raw = row["companion_path"]
    companion_path = Path(str(companion_raw)) if companion_raw else None
    # photos.width/height 是主文件(JPG)EXIF 维度。companion fallback 后,result.bbox
    # 在 RAW 像素空间,需要按比例缩放到主文件空间,UI bboxToPercentBoxes 才能正确渲染。
    primary_width = int(row["width"]) if row["width"] is not None else 0
    primary_height = int(row["height"]) if row["height"] is not None else 0

    current_version = pipeline.pipeline_version

    if not force_rerun:
        cached = await get_result_for_version(db, photo_id, current_version)
        if cached is not None:
            await logger.ainfo(
                "Cache hit",
                photo_id=photo_id,
                pipeline_version=current_version,
            )
            # 命中仍需确保 active（可能被手动切换过）
            await store_result(db, photo_id, cached)
            return AnalysisOutcome(result=cached, from_cache=True)

    # 同步 stat 对本地文件来说耗时可忽略，不值得额外 asyncio.to_thread 包装
    if not file_path.exists():  # noqa: ASYNC240
        msg = f"File not found on disk: {file_path}"
        raise FileNotFoundError(msg)

    await logger.ainfo(
        "Running pipeline inference",
        photo_id=photo_id,
        pipeline_version=current_version,
        force_rerun=force_rerun,
    )
    try:
        result = await pipeline.analyze(file_path, photo_id=photo_id)
    except (OSError, ValueError) as e:
        # 仅在"读图阶段错误"时 fallback 到 companion(RAW)。覆盖范围:
        #   - PIL OSError "broken data stream" / "image file is truncated"
        #   - PIL UnidentifiedImageError(继承 OSError)
        #   - rawpy LibRawIOError(继承 OSError)
        #   - 我们自己的 ValueError("Unsupported image format")
        # 不 fallback:模型 abort / MPS GPU 错误 / 内存爆 / 算法异常 — 这些跟主/同伴
        # 文件无关,fallback 也是浪费,直接 raise 让 task_queue 记 DEAD。
        if companion_path is None or not companion_path.exists():  # noqa: ASYNC240
            raise
        await logger.awarning(
            "Pipeline failed on primary, trying companion fallback",
            photo_id=photo_id,
            primary=str(file_path),
            companion=str(companion_path),
            error=str(e),
        )
        result = await pipeline.analyze(companion_path, photo_id=photo_id)
        result.companion_used = True
        # bbox/keypoint 来自 RAW 像素空间(image_width/image_height = RAW 尺寸);
        # 主文件(JPG)EXIF 维度可能不同(典型差异 几px ~ 几% 边距),需缩放到主文件空间
        # 否则前端 row.width/height 做归一化后 bbox 整体偏移。
        if (
            primary_width > 0
            and primary_height > 0
            and result.image_width > 0
            and result.image_height > 0
            and (
                result.image_width != primary_width
                or result.image_height != primary_height
            )
        ):
            sx = primary_width / result.image_width
            sy = primary_height / result.image_height
            await logger.ainfo(
                "Rescaling companion fallback bbox to primary space",
                photo_id=photo_id,
                analyzed_dims=(result.image_width, result.image_height),
                primary_dims=(primary_width, primary_height),
                scale=(sx, sy),
            )
            # result.best 是 detections 中某条的引用(manager 用 max() 选出),
            # 缩放 detections 已覆盖 best,不要再单独缩放 best 否则会双重缩放。
            for det in result.detections:
                _scale_detection(det, sx, sy)
            result.image_width = primary_width
            result.image_height = primary_height
        await logger.ainfo(
            "Companion fallback succeeded",
            photo_id=photo_id,
            companion=str(companion_path),
        )

    await store_result(db, photo_id, result)

    return AnalysisOutcome(result=result, from_cache=False)


def _scale_detection(det: BirdAnalysis, sx: float, sy: float) -> None:
    """In-place scale bbox + pose keypoints by (sx, sy) for coord-space migration."""
    det.bbox.x1 *= sx
    det.bbox.x2 *= sx
    det.bbox.y1 *= sy
    det.bbox.y2 *= sy
    if det.pose is not None:
        _scale_pose(det.pose, sx, sy)


def _scale_pose(pose: PoseInfo, sx: float, sy: float) -> None:
    """In-place scale all 11 keypoints of a PoseInfo."""
    for kp_name in (
        "bill", "crown", "nape", "left_eye", "right_eye",
        "belly", "breast", "back", "tail", "left_wing", "right_wing",
    ):
        kp = getattr(pose, kp_name)
        kp.x *= sx
        kp.y *= sy
