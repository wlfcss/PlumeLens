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
from engine.pipeline.models import PipelineResult
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
        "SELECT file_path, companion_path FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        msg = f"Photo not found: {photo_id}"
        raise RuntimeError(msg)
    file_path = Path(str(row["file_path"]))
    companion_raw = row["companion_path"]
    companion_path = Path(str(companion_raw)) if companion_raw else None

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
        await logger.ainfo(
            "Companion fallback succeeded",
            photo_id=photo_id,
            companion=str(companion_path),
        )

    await store_result(db, photo_id, result)

    return AnalysisOutcome(result=result, from_cache=False)
