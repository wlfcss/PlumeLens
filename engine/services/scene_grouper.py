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
from pathlib import Path

import structlog

from engine.core.database import Database
from engine.pipeline.scene_grouping import (
    compute_similarity,
    load_image_for_similarity,
)

logger = structlog.stdlib.get_logger()


def _resolve_preview_path(thumb_preview: str | None, cache_root: Path) -> Path | None:
    """thumb_preview 是相对路径 'preview/{photo_id}.jpg' → 绝对磁盘路径。"""
    if not thumb_preview:
        return None
    p = cache_root / thumb_preview
    return p if p.exists() else None


def _compute_pair_sync(prev_path: Path, cur_path: Path) -> bool:
    """同步计算两张图是否同场景（运行在 to_thread）。"""
    img_prev = load_image_for_similarity(prev_path)
    img_cur = load_image_for_similarity(cur_path)
    if img_prev is None or img_cur is None:
        # 加载失败 → 保守起见标为不相似（开新场景）
        return False
    sim = compute_similarity(img_prev, img_cur)
    return bool(sim.similar)


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
    # 取所有 photo，按 file_mtime（拍摄时间近似）排序
    async with db.conn.execute(
        "SELECT id, thumb_preview, file_mtime "
        "FROM photos WHERE library_id = ? "
        "ORDER BY file_mtime ASC",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    if not rows:
        return {"scanned": 0, "scenes": 0, "skipped": 0}

    scene_id = 0
    skipped = 0
    prev_path: Path | None = None
    updates: list[tuple[int, str]] = []  # (scene_id, photo_id)

    for row in rows:
        photo_id = str(row["id"])
        cur_path = _resolve_preview_path(
            str(row["thumb_preview"]) if row["thumb_preview"] else None, cache_root,
        )

        if prev_path is None or cur_path is None:
            # 第一张 OR 当前缩略图缺失 → 新场景（保守）
            if cur_path is None and prev_path is not None:
                skipped += 1
                # 没法判定相似度，沿用前一场景（连拍中间一张缩略图丢了也算同一场景）
                # 这是经验权衡：宁可少切也别错切
                pass
            elif prev_path is not None and cur_path is not None:
                # 不会进这个分支（被上面 if 包住了）
                pass
            updates.append((scene_id, photo_id))
        else:
            # 跑相似度（cv2 在 thread pool）
            try:
                similar = await asyncio.to_thread(_compute_pair_sync, prev_path, cur_path)
            except Exception as e:
                logger.warning(
                    "scene similarity exception",
                    library_id=library_id,
                    photo_id=photo_id,
                    error=str(e),
                )
                similar = False
            if not similar:
                scene_id += 1
            updates.append((scene_id, photo_id))

        if cur_path is not None:
            prev_path = cur_path

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
