"""羽迹三级地图聚合的进程内 TTL 缓存。

这层缓存是 archive 路由内的"短窗口降负载"机制 — 用户在中国/省/市/拍摄点之间
反复切换时，不必每次都重跑 _load_geo_photos 的全库 result_json 反序列化 +
overrides 应用 + group consensus。

业务口径(manual override / group consensus / model_unconfirmed 排除)在 archive
路由内部解析 — 不能用纯 SQL `GROUP BY species` 替代。短期通过 TTL + 写入路径
主动 invalidate 收敛性能。

不放在 `engine/api/routes/archive.py` 内是为了让写入路径(decisions / cache /
exporter)能 import 同一份 cache 状态调 invalidate,又不引入循环依赖
(archive.py 已经反向 import decisions)。
"""

from __future__ import annotations

from time import monotonic
from typing import Any

# TTL 选 10s — 用户反复切省/市/点的窗口,但写入(decision / override / 新分析)
# 落地后由调用方主动 invalidate,不用等 TTL。
GEO_CACHE_TTL_SECONDS = 10.0
# 上限 64 entries — 中国 34 个省+地+特别行政区,城市级聚合按"省"分桶,每个桶
# 一份 cache。64 足够覆盖正常浏览深度,超过则 LRU 踢最旧的。
GEO_CACHE_MAX_ENTRIES = 64

_geo_cache: dict[str, tuple[float, Any]] = {}
_generation: int = 0


def generation() -> int:
    """Monotonic cache generation; bumped on every invalidate() to block stale write-backs."""
    return _generation


def get(key: str) -> Any | None:
    """命中且未过期返回值;过期或未命中返回 None。"""
    cached = _geo_cache.get(key)
    if cached is None:
        return None
    created_at, value = cached
    if monotonic() - created_at > GEO_CACHE_TTL_SECONDS:
        _geo_cache.pop(key, None)
        return None
    return value


def put(key: str, value: Any, *, expected_generation: int | None = None) -> Any:
    """写入并返回 value(便于链式调用)。超上限时踢最旧条目。

    If `expected_generation` is supplied and `invalidate()` ran since the caller
    started querying SQLite, skip inserting so stale data cannot poison the cache.
    """
    if expected_generation is not None and expected_generation != _generation:
        return value
    _geo_cache[key] = (monotonic(), value)
    if len(_geo_cache) > GEO_CACHE_MAX_ENTRIES:
        oldest = min(_geo_cache.items(), key=lambda item: item[1][0])[0]
        _geo_cache.pop(oldest, None)
    return value


def invalidate() -> None:
    """清空所有羽迹聚合缓存。decisions / overrides / 新分析落地后调用。

    粒度故意做粗 — archive 聚合跨 library / 跨 photo,精确 invalidate 单个键
    成本 > 简单全清,且 10s TTL 已限定缓存命中窗口很短。
    """
    global _generation
    _generation += 1
    _geo_cache.clear()


def size() -> int:
    """测试用:当前缓存条数。"""
    return len(_geo_cache)
