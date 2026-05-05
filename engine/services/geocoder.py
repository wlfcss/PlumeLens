# pyright: basic
"""Reverse geocoding 服务 — 多 provider chain + 离线兜底。

链路(优先级递减):
  1. 高德 (PLUMELENS_AMAP_KEY 设置时启用)        — 国内最稳,POI 级中文
  2. 百度 (PLUMELENS_BAIDU_AK 设置时启用)        — 国内备选
  3. 腾讯 (PLUMELENS_TENCENT_KEY 设置时启用)     — 国内备选
  4. Nominatim (OSM,无需 key)                    — 国际开放,国内访问不稳
  5. 离线 cities1000(GeoNames,bundled)          — 永远兜底,只能给城市级

每个 provider 设 2s 超时,失败/超时立刻切下一个。结果 LRU 缓存(round 到 ~10m
精度),同一场景照片共用查询。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypedDict

import numpy as np
import structlog

logger = structlog.stdlib.get_logger()

# 公共配置
TIMEOUT_SEC = 2.5
USER_AGENT = "PlumeLens/0.5.0 (rev-geocoding)"
CACHE_MAX = 1024
# 离线兜底距离上限(经度差^2 + 纬度差^2 加权,单位约等于度^2)。
# nearest city 超过这个距离就返回 None — 避免南极坐标落到非洲城市这种荒诞结果。
# 1.0 度^2 ≈ 110km^2,合理:GeoNames cities1000 在大部分人居区域密度 < 100km。
_OFFLINE_MAX_DIST_DEG2 = 1.0


def _is_valid_coord(lat: float, lon: float) -> bool:
    """挡掉 NaN/Inf/越界/(0,0) Null Island — 损坏 EXIF 常见伪造值,污染 cache 即误。"""
    import math
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return False
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return False
    # (0,0) 是 EXIF DMS 全 0 的产物(损坏的 GPS),实际海面无意义
    return not (abs(lat) < 0.001 and abs(lon) < 0.001)


class GeocodeResult(TypedDict):
    display_name: str  # 人类可读地址(各 provider 格式不同)
    source: str        # provider 标识(amap / baidu / tencent / nominatim / offline)
    lat: float
    lon: float


# ---------------------------------------------------------------------------
# LRU cache: round 坐标到 4 位小数(~11m 精度)做 key,同场景照片共用
# ---------------------------------------------------------------------------
_cache: OrderedDict[tuple[int, int, str], GeocodeResult | None] = OrderedDict()


def _cache_key(lat: float, lon: float, lang: str) -> tuple[int, int, str]:
    return (round(lat * 10000), round(lon * 10000), lang)


def _cache_get(key: tuple[int, int, str]) -> GeocodeResult | None | object:
    """命中返回结果(可能是 None);未命中返回 sentinel object()。"""
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    return _MISS


_MISS = object()


def _cache_put(key: tuple[int, int, str], value: GeocodeResult | None) -> None:
    _cache[key] = value
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


# ---------------------------------------------------------------------------
# HTTP helper(stdlib urllib + asyncio.to_thread,避免引入 httpx 运行时依赖)
# ---------------------------------------------------------------------------
def _http_get_json(url: str, timeout: float = TIMEOUT_SEC) -> dict[str, Any] | None:
    """同步 GET → JSON。失败返回 None,不抛。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Online providers
# ---------------------------------------------------------------------------
async def _provider_amap(lat: float, lon: float, lang: str) -> GeocodeResult | None:
    """高德 reverse geocoding。免费配额 30万次/月(个人 key)。"""
    key = os.environ.get("PLUMELENS_AMAP_KEY")
    if not key:
        return None
    # 注意:高德 location 是 "lon,lat" 顺序;坐标系默认 GCJ-02。WGS84 需要 coordsys 参数,
    # 但 amap reverse 不支持 — 鸟摄场景这点偏移(中国境内 ~50m)对城市级反查影响小。
    params = urllib.parse.urlencode({
        "key": key,
        "location": f"{lon:.6f},{lat:.6f}",
        "extensions": "base",
        "output": "json",
        "radius": "500",  # 米 — 取附近 500m 内的 POI / 街道
    })
    url = f"https://restapi.amap.com/v3/geocode/regeo?{params}"
    data = await asyncio.to_thread(_http_get_json, url)
    if not data or data.get("status") != "1":
        return None
    regeo = data.get("regeocode") or {}
    formatted = regeo.get("formatted_address")
    if not formatted:
        return None
    return GeocodeResult(display_name=str(formatted), source="amap", lat=lat, lon=lon)


async def _provider_baidu(lat: float, lon: float, lang: str) -> GeocodeResult | None:
    """百度 reverse geocoding v3。免费配额 6000次/日(个人 ak)。"""
    ak = os.environ.get("PLUMELENS_BAIDU_AK")
    if not ak:
        return None
    # 百度默认 BD09 坐标系;coordtype=wgs84ll 让其内部转换
    params = urllib.parse.urlencode({
        "ak": ak,
        "location": f"{lat:.6f},{lon:.6f}",
        "coordtype": "wgs84ll",
        "output": "json",
        "extensions_poi": "0",
    })
    url = f"https://api.map.baidu.com/reverse_geocoding/v3/?{params}"
    data = await asyncio.to_thread(_http_get_json, url)
    if not data or data.get("status") != 0:
        return None
    result = data.get("result") or {}
    formatted = result.get("formatted_address")
    if not formatted:
        return None
    sematic = result.get("sematic_description") or ""
    full = f"{formatted} {sematic}".strip() if sematic else formatted
    return GeocodeResult(display_name=str(full), source="baidu", lat=lat, lon=lon)


async def _provider_tencent(lat: float, lon: float, lang: str) -> GeocodeResult | None:
    """腾讯地图 WebService。免费 1万次/日(个人 key)。"""
    key = os.environ.get("PLUMELENS_TENCENT_KEY")
    if not key:
        return None
    params = urllib.parse.urlencode({
        "key": key,
        "location": f"{lat:.6f},{lon:.6f}",
        "get_poi": "0",
    })
    url = f"https://apis.map.qq.com/ws/geocoder/v1/?{params}"
    data = await asyncio.to_thread(_http_get_json, url)
    if not data or data.get("status") != 0:
        return None
    result = data.get("result") or {}
    formatted = result.get("address") or ""
    formatted_zh = (result.get("formatted_addresses") or {}).get("recommend") or formatted
    if not formatted_zh:
        return None
    return GeocodeResult(display_name=str(formatted_zh), source="tencent", lat=lat, lon=lon)


# Nominatim 1 req/s 限制:全局节流,避免被封。
# 关键:lock 必须覆盖整个 HTTP 请求(含 await asyncio.to_thread),
# 这样多个并发 caller 真正会被串行化为 1 req/s。之前 lock 只覆盖时间戳记账,
# HTTP 在 lock 外并发执行 → 50 个 concurrent caller 会同时发 50 个 HTTP 请求被封。
_nominatim_lock = asyncio.Lock()
_nominatim_last_ts = 0.0


async def _provider_nominatim(lat: float, lon: float, lang: str) -> GeocodeResult | None:
    """Nominatim (OpenStreetMap) — 无需 key,但国内访问可能慢/失败。"""
    global _nominatim_last_ts
    params = urllib.parse.urlencode({
        "format": "json",
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "zoom": "16",
        "addressdetails": "1",
        "accept-language": lang,
    })
    url = f"https://nominatim.openstreetmap.org/reverse?{params}"
    # lock 覆盖整个: 节流等待 + HTTP 调用 + 时间戳更新 — 真正全局 1 req/s
    async with _nominatim_lock:
        elapsed = time.monotonic() - _nominatim_last_ts
        if elapsed < 1.1:
            await asyncio.sleep(1.1 - elapsed)
        data = await asyncio.to_thread(_http_get_json, url)
        _nominatim_last_ts = time.monotonic()
    if not data or "display_name" not in data:
        return None
    return GeocodeResult(
        display_name=str(data["display_name"]),
        source="nominatim",
        lat=lat,
        lon=lon,
    )


# ---------------------------------------------------------------------------
# Offline provider:GeoNames cities1000 brute-force nearest-city
# ---------------------------------------------------------------------------
_offline_data: tuple[np.ndarray, list[dict[str, Any]]] | None = None
_offline_load_lock = asyncio.Lock()


def _offline_data_dir() -> Path:
    """PyInstaller bundle 时数据在 _MEIPASS;dev 时在源码目录。"""
    if hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "engine" / "data"  # type: ignore[attr-defined]
    return Path(__file__).parent.parent / "data"


def _load_offline() -> tuple[np.ndarray, list[dict[str, Any]]] | None:
    path = _offline_data_dir() / "cities1000.npz"
    if not path.exists():
        logger.warning("Offline geocoding data missing", path=str(path))
        return None
    try:
        npz = np.load(str(path), allow_pickle=True)
        coords = np.asarray(npz["coords"], dtype=np.float32)
        meta_arr = npz["meta"]
        # meta 是 object array,转 list[dict]
        meta_list: list[dict[str, Any]] = [dict(m) for m in meta_arr]
        return coords, meta_list
    except Exception:
        logger.exception("Failed to load offline geocoding data", path=str(path))
        return None


async def _provider_offline(lat: float, lon: float, lang: str) -> GeocodeResult | None:
    """Brute-force nearest-city lookup over cities1000(~150K entries,
    numpy 广播单次 query ~5ms。一次进程内只 load 一次。"""
    global _offline_data
    if _offline_data is None:
        async with _offline_load_lock:
            if _offline_data is None:
                _offline_data = await asyncio.to_thread(_load_offline)
    if _offline_data is None:
        return None
    coords, meta = _offline_data

    def _query() -> tuple[int, float]:
        # Equirectangular distance with cosine longitude correction — 只为找 nearest
        # neighbor,不需要精确大圆距离;城市间间距通常 > 1km,误差可忽略。
        d_lat = coords[:, 0] - lat
        d_lon = (coords[:, 1] - lon) * np.cos(np.radians(lat))
        sq = d_lat * d_lat + d_lon * d_lon
        i = int(np.argmin(sq))
        return i, float(sq[i])

    idx, dist_sq = await asyncio.to_thread(_query)
    # 距离过大 → nearest city 还是离照片极远(比如南极坐标找到非洲城市) — 没价值
    if dist_sq > _OFFLINE_MAX_DIST_DEG2:
        return None
    entry = meta[idx]
    parts = [
        str(entry.get(k, "")).strip()
        for k in ("country", "admin1", "admin2", "name")
    ]
    parts = [p for p in parts if p]
    return GeocodeResult(
        display_name=" ".join(parts) if parts else "(unknown)",
        source="offline",
        lat=lat,
        lon=lon,
    )


# ---------------------------------------------------------------------------
# Provider chain
# ---------------------------------------------------------------------------
ProviderFn = Callable[[float, float, str], "asyncio.Future[GeocodeResult | None]"]

_CHAIN: tuple[Callable[..., Any], ...] = (
    _provider_amap,
    _provider_baidu,
    _provider_tencent,
    _provider_nominatim,
    _provider_offline,
)


async def reverse(lat: float, lon: float, lang: str = "zh-CN") -> GeocodeResult | None:
    """按 chain 顺序尝试,第一个成功的 provider 胜出。所有失败返回 None。"""
    # 输入校验 — NaN/Inf/越界/(0,0) 直接拒绝,不浪费 provider 配额也不污染 cache
    if not _is_valid_coord(lat, lon):
        return None
    key = _cache_key(lat, lon, lang)
    cached = _cache_get(key)
    if cached is not _MISS:
        return cached  # type: ignore[return-value]

    for provider in _CHAIN:
        try:
            result = await asyncio.wait_for(provider(lat, lon, lang), timeout=TIMEOUT_SEC + 0.5)
        except TimeoutError:
            await logger.awarning(
                "Geocoding provider timeout",
                provider=provider.__name__,
                lat=lat,
                lon=lon,
            )
            continue
        except Exception:
            logger.exception("Geocoding provider exception", provider=provider.__name__)
            continue
        if result is not None:
            _cache_put(key, result)
            return result

    _cache_put(key, None)
    return None
